const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { processIncomingMessage } = require('../agent/orchestrator');

const MAX_INSTANCES = 5;
const instances = new Map(); // id -> { id, name, sock, status, qrCode, authDir }
const processedMessageIds = new Set();
const messageBuffers = new Map(); // `${instanceId}:${phone}` -> { timer, messages: [], remoteJid }

const baseAuthDir = path.join(__dirname, '..', '..', 'data', 'baileys_auth');
if (!fs.existsSync(baseAuthDir)) {
    fs.mkdirSync(baseAuthDir, { recursive: true });
}

// Configuração inicial das 5 instâncias
const defaultInstanceNames = [
    'WhatsApp 1 (Dr. Glaucio - Principal)',
    'WhatsApp 2 (Atendimento 2)',
    'WhatsApp 3 (Atendimento 3)',
    'WhatsApp 4 (Atendimento 4)',
    'WhatsApp 5 (Atendimento 5)'
];

function getInstancesMetadataFile() {
    return path.join(baseAuthDir, 'instances_meta.json');
}

function loadInstancesMeta() {
    try {
        const file = getInstancesMetadataFile();
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {}
    
    const meta = {};
    for (let i = 1; i <= MAX_INSTANCES; i++) {
        meta[`instance_${i}`] = {
            id: `instance_${i}`,
            name: defaultInstanceNames[i - 1] || `WhatsApp ${i}`,
            enabled: true
        };
    }
    saveInstancesMeta(meta);
    return meta;
}

function saveInstancesMeta(meta) {
    try {
        fs.writeFileSync(getInstancesMetadataFile(), JSON.stringify(meta, null, 2), 'utf8');
    } catch (e) {
        console.error('[INSTANCES META SAVE ERROR]', e);
    }
}

function addToProcessedCache(id) {
    if (!id) return;
    processedMessageIds.add(id);
    if (processedMessageIds.size > 2000) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
    }
}

async function handleBufferedMessages(instanceId, phone, remoteJid) {
    const key = `${instanceId}:${phone}`;
    const buffer = messageBuffers.get(key);
    if (!buffer || buffer.messages.length === 0) return;

    const combinedText = buffer.messages.join('\n').trim();
    messageBuffers.delete(key);

    if (!combinedText) return;

    const instance = instances.get(instanceId);
    if (!instance || !instance.sock || instance.status !== 'connected') return;

    console.log(`\n📩 [${instance.name} RECEBIDO de ${phone}]: "${combinedText}"`);

    try {
        await instance.sock.sendPresenceUpdate('composing', remoteJid);
    } catch (e) {}

    // Processa com a IA identificando a instância
    const reply = await processIncomingMessage(phone, combinedText, instanceId);

    if (reply && instance.sock && instance.status === 'connected') {
        await instance.sock.sendMessage(remoteJid, { text: reply });
        console.log(`🤖 [${instance.name} RESPOSTA ENVIADA para ${phone}]: "${reply.substring(0, 70)}..."`);
    }
}

async function startInstance(instanceId, instanceName) {
    const authDir = path.join(baseAuthDir, instanceId);
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    const instanceObj = {
        id: instanceId,
        name: instanceName,
        sock: null,
        status: 'disconnected',
        qrCode: null,
        authDir: authDir
    };
    instances.set(instanceId, instanceObj);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: false,
            browser: ['Glaucio Dias Advocacia', 'Chrome', '1.0.0'],
            syncFullHistory: false
        });

        instanceObj.sock = sock;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log(`\n📱 [NOVO QR CODE PARA ${instanceName} GERADO]`);
                instanceObj.qrCode = await QRCode.toDataURL(qr);
                instanceObj.status = 'connecting';
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[${instanceName}] Conexão encerrada (Status: ${statusCode}). Reconectando: ${shouldReconnect}`);
                instanceObj.status = 'disconnected';
                instanceObj.qrCode = null;
                if (shouldReconnect) {
                    setTimeout(() => startInstance(instanceId, instanceName), 4000);
                }
            } else if (connection === 'open') {
                console.log(`\n✅ [${instanceName} CONECTADO COM SUCESSO!]: Ativo 24h.`);
                instanceObj.status = 'connected';
                instanceObj.qrCode = null;
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                const msgId = msg.key.id;
                if (processedMessageIds.has(msgId)) continue;
                addToProcessedCache(msgId);

                const remoteJid = msg.key.remoteJid || '';
                if (remoteJid.includes('@g.us')) continue; // Ignora grupos
                if (msg.key.fromMe) continue;

                let messageText = '';
                if (msg.message?.conversation) {
                    messageText = msg.message.conversation;
                } else if (msg.message?.extendedTextMessage?.text) {
                    messageText = msg.message.extendedTextMessage.text;
                }

                if (!messageText.trim()) continue;

                const phone = remoteJid.replace('@s.whatsapp.net', '');
                const bufferKey = `${instanceId}:${phone}`;

                if (!messageBuffers.has(bufferKey)) {
                    messageBuffers.set(bufferKey, {
                        messages: [messageText],
                        remoteJid: remoteJid,
                        timer: setTimeout(() => handleBufferedMessages(instanceId, phone, remoteJid), 1200)
                    });
                } else {
                    const current = messageBuffers.get(bufferKey);
                    current.messages.push(messageText);
                    clearTimeout(current.timer);
                    current.timer = setTimeout(() => handleBufferedMessages(instanceId, phone, remoteJid), 1200);
                }
            }
        });
    } catch (err) {
        console.error(`[${instanceName} START ERROR]`, err);
    }
}

async function startWhatsAppBot() {
    const meta = loadInstancesMeta();
    for (let i = 1; i <= MAX_INSTANCES; i++) {
        const id = `instance_${i}`;
        const info = meta[id] || { name: `WhatsApp ${i}` };
        await startInstance(id, info.name);
    }
}

function getAllWhatsAppStatus() {
    const meta = loadInstancesMeta();
    const list = [];
    for (let i = 1; i <= MAX_INSTANCES; i++) {
        const id = `instance_${i}`;
        const inst = instances.get(id);
        const name = meta[id]?.name || `WhatsApp ${i}`;
        list.push({
            id: id,
            name: name,
            status: inst ? inst.status : 'disconnected',
            qrCode: inst ? inst.qrCode : null
        });
    }
    return list;
}

function getWhatsAppStatus(instanceId = 'instance_1') {
    const inst = instances.get(instanceId);
    return {
        status: inst ? inst.status : 'disconnected',
        qrCode: inst ? inst.qrCode : null
    };
}

async function resetWhatsAppSession(instanceId = 'instance_1') {
    const inst = instances.get(instanceId);
    if (inst) {
        console.log(`[WHATSAPP] Resetando ${inst.name}...`);
        try {
            if (inst.sock) {
                inst.sock.end();
                inst.sock = null;
            }
            if (fs.existsSync(inst.authDir)) {
                fs.rmSync(inst.authDir, { recursive: true, force: true });
                fs.mkdirSync(inst.authDir, { recursive: true });
            }
            inst.status = 'disconnected';
            inst.qrCode = null;
            setTimeout(() => startInstance(instanceId, inst.name), 1500);
            return true;
        } catch (e) {
            console.error('[RESET SESSION ERROR]', e);
            return false;
        }
    }
    return false;
}

function renameInstance(instanceId, newName) {
    const meta = loadInstancesMeta();
    if (meta[instanceId]) {
        meta[instanceId].name = newName;
        saveInstancesMeta(meta);
        const inst = instances.get(instanceId);
        if (inst) inst.name = newName;
        return true;
    }
    return false;
}

async function sendDirectMessage(phone, text, instanceId = null) {
    let targetInstance = null;
    if (instanceId && instances.has(instanceId)) {
        targetInstance = instances.get(instanceId);
    } else {
        // Encontra a primeira instância conectada
        for (const inst of instances.values()) {
            if (inst.status === 'connected') {
                targetInstance = inst;
                break;
            }
        }
    }

    if (!targetInstance || !targetInstance.sock || targetInstance.status !== 'connected') {
        return false;
    }

    const cleanPhone = phone.replace(/\D/g, '');
    const remoteJid = `${cleanPhone}@s.whatsapp.net`;
    await targetInstance.sock.sendMessage(remoteJid, { text });
    return true;
}

module.exports = {
    startWhatsAppBot,
    getAllWhatsAppStatus,
    getWhatsAppStatus,
    resetWhatsAppSession,
    renameInstance,
    sendDirectMessage
};
