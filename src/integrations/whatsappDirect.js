const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');
const { processIncomingMessage } = require('../agent/orchestrator');
const DatabaseService = require('../database');
const Logger = require('../logger');

const MAX_INSTANCES = 5;
const baseAuthDir = path.join(__dirname, '..', '..', 'data', 'baileys_auth');
const metaFile = path.join(baseAuthDir, 'instances_meta.json');

if (!fs.existsSync(baseAuthDir)) {
    fs.mkdirSync(baseAuthDir, { recursive: true });
}

function loadInstancesMeta() {
    try {
        if (fs.existsSync(metaFile)) {
            return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        }
    } catch (e) {
        console.error('[META LOAD ERROR]', e);
    }
    return {
        instance_1: { name: 'Linha Principal 1' },
        instance_2: { name: 'Linha 2' },
        instance_3: { name: 'Linha 3' },
        instance_4: { name: 'Linha 4' },
        instance_5: { name: 'Linha 5' }
    };
}

function saveInstancesMeta(meta) {
    try {
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf8');
    } catch (e) {
        console.error('[META SAVE ERROR]', e);
    }
}

// Resolve o número de telefone real brasileiro a partir do JID ou do LID
function resolveRealPhone(authDir, remoteJid) {
    if (!remoteJid) return '';
    const jid = remoteJid.split(':')[0];
    if (jid.endsWith('@s.whatsapp.net')) {
        return jid.split('@')[0];
    }
    if (jid.endsWith('@lid')) {
        const lid = jid.split('@')[0];
        const reverseFile = path.join(authDir, `lid-mapping-${lid}_reverse.json`);
        if (fs.existsSync(reverseFile)) {
            try {
                const phone = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
                if (phone) return String(phone);
            } catch (e) {}
        }
    }
    return jid.split('@')[0];
}

// Extrai texto de mensagens, desempacotando wrappers do WhatsApp (deviceSentMessage, ephemeral, etc.)
function extractMessageText(msg) {
    if (!msg || !msg.message) return '';

    let m = msg.message;
    if (m.deviceSentMessage?.message) m = m.deviceSentMessage.message;
    if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
    if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
    if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
    if (m.documentWithCaptionMessage?.message) m = m.documentWithCaptionMessage.message;

    return m.conversation || 
           m.extendedTextMessage?.text || 
           m.imageMessage?.caption || 
           m.videoMessage?.caption || 
           m.buttonsResponseMessage?.selectedButtonId || 
           m.listResponseMessage?.singleSelectReply?.selectedRowId || 
           m.templateButtonReplyMessage?.selectedId || '';
}

const instances = new Map();
const messageBuffers = new Map();
const processedMessageIds = new Set();
const sentByBotMessageIds = new Set();

function addToProcessedCache(id) {
    if (!id) return;
    processedMessageIds.add(id);
    if (processedMessageIds.size > 3000) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
    }
}

async function handleBufferedMessages(instanceId, cleanPhone, remoteJid) {
    const key = `${instanceId}:${cleanPhone}`;
    const buffer = messageBuffers.get(key);
    if (!buffer || buffer.messages.length === 0) return;

    const combinedText = buffer.messages.join('\n').trim();
    messageBuffers.delete(key);

    if (!combinedText) return;

    const instance = instances.get(instanceId);
    if (!instance || !instance.sock) {
        console.error(`[BUFFER ERROR] Instância ${instanceId} ou socket inexistente.`);
        return;
    }

    // Tenta re-resolver o telefone caso o mapping tenha sido gravado no debounce
    const realPhone = resolveRealPhone(instance.authDir, remoteJid);
    const finalCleanPhone = DatabaseService.normalizePhone(realPhone) || cleanPhone;

    console.log(`\n📩 [${instance.name} RECEBIDO de ${finalCleanPhone} (JID: ${remoteJid})]: "${combinedText}"`);

    try {
        await instance.sock.sendPresenceUpdate('composing', remoteJid);
    } catch (e) {}

    // Processa com o motor de triagem inteligente passando o remoteJid para persistência
    const reply = await processIncomingMessage(finalCleanPhone, combinedText, instanceId, remoteJid);

    if (reply && instance.sock) {
        let sent = false;
        // 1ª Tentativa: Enviar diretamente no JID de onde veio (LID ou número)
        try {
            const res = await instance.sock.sendMessage(remoteJid, { text: reply });
            if (res?.key?.id) {
                sentByBotMessageIds.add(res.key.id);
                addToProcessedCache(res.key.id);
            }
            sent = true;
            console.log(`🤖 [${instance.name} RESPOSTA ENVIADA DIRETA para ${finalCleanPhone} (JID: ${remoteJid})]: "${reply.substring(0, 70)}..."`);
        } catch (err) {
            console.error(`⚠️ [${instance.name} FALHA AO ENVIAR DIRETO para ${remoteJid}]:`, err.message);
        }

        // 2ª Tentativa (fallback): Se falhar no LID, tenta no JID padrão do telefone
        if (!sent && finalCleanPhone) {
            try {
                const fallbackJid = `${finalCleanPhone}@s.whatsapp.net`;
                console.log(`🔄 [${instance.name} TENTANDO FALLBACK para ${fallbackJid}]...`);
                const res = await instance.sock.sendMessage(fallbackJid, { text: reply });
                if (res?.key?.id) {
                    sentByBotMessageIds.add(res.key.id);
                    addToProcessedCache(res.key.id);
                }
                sent = true;
                console.log(`🤖 [${instance.name} RESPOSTA ENVIADA VIA FALLBACK para ${fallbackJid}]`);
            } catch (err2) {
                console.error(`❌ [${instance.name} ERRO FATAL AO ENVIAR no fallback]:`, err2.message);
            }
        }
    }
}

function syncAuthDirToSqlite(instanceId, authDir) {
    try {
        if (!fs.existsSync(authDir)) return;
        const files = fs.readdirSync(authDir);
        for (const file of files) {
            if (file.endsWith('.json')) {
                const filePath = path.join(authDir, file);
                const content = fs.readFileSync(filePath, 'utf8');
                DatabaseService.saveSessionFile(instanceId, file, content);
            }
        }
    } catch (e) {}
}

async function startInstance(instanceId, instanceName) {
    const authDir = path.join(baseAuthDir, instanceId);
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }

    // Restaura sessão permanente salva no SQLite antes de abrir o Baileys
    await DatabaseService.restoreSessionFiles(instanceId, authDir);

    const hasStoredCreds = fs.existsSync(path.join(authDir, 'creds.json'));

    const instanceObj = {
        id: instanceId,
        name: instanceName,
        sock: null,
        status: hasStoredCreds ? 'CONNECTING' : 'DISCONNECTED',
        qrCode: null,
        authDir: authDir,
        user: null
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
            browser: Browsers.macOS('Chrome'),
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            getMessage: async () => ({ conversation: '' })
        });

        instanceObj.sock = sock;

        sock.ev.on('creds.update', async () => {
            await saveCreds();
            syncAuthDirToSqlite(instanceId, authDir);
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    instanceObj.qrCode = await qrcode.toDataURL(qr);
                    instanceObj.status = 'DISCONNECTED';
                } catch (e) {
                    console.error(`[${instanceName} QR GENERATION ERROR]`, e);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                instanceObj.qrCode = null;

                if (shouldReconnect) {
                    instanceObj.status = 'RECONNECTING';
                    setTimeout(() => startInstance(instanceId, instanceName), 5000);
                } else {
                    instanceObj.status = 'DISCONNECTED';
                    instanceObj.user = null;
                }
            } else if (connection === 'open') {
                instanceObj.status = 'CONNECTED';
                instanceObj.qrCode = null;
                instanceObj.user = sock.user?.id || null;
                console.log(`\n✅ [${instanceName} CONECTADO COM SUCESSO NO WHATSAPP!] User: ${instanceObj.user}`);
                syncAuthDirToSqlite(instanceId, authDir);
                Logger.log('CRM_SYNC_SUCCESS', { instanceId, user: instanceObj.user });
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            console.log(`[BAILEYS MSG UPSERT] Recebido ${messages?.length || 0} msgs, tipo: ${type}`);
            for (const msg of messages) {
                const msgId = msg.key?.id;
                if (!msgId) continue;
                if (processedMessageIds.has(msgId) || sentByBotMessageIds.has(msgId)) continue;
                addToProcessedCache(msgId);

                const remoteJid = msg.key?.remoteJid || '';

                // FILTRA GRUPOS, CANAIS (NEWSLETTER), TRANSMISSÕES E STATUS
                if (!remoteJid || 
                    remoteJid.includes('@g.us') || 
                    remoteJid.includes('@newsletter') || 
                    remoteJid.includes('@broadcast') || 
                    remoteJid.includes('status@broadcast') ||
                    remoteJid.includes('@call')) {
                    continue;
                }

                // Resolve o número real do contato (converte LID para número de telefone real)
                const rawPhone = resolveRealPhone(authDir, remoteJid);
                const cleanPhone = DatabaseService.normalizePhone(rawPhone);

                // Detecta se é mensagem enviada pelo próprio número conectado (auto-chat de teste)
                const rawBot = instanceObj.user ? instanceObj.user.split('@')[0].split(':')[0] : '';
                const botPhone = DatabaseService.normalizePhone(rawBot);
                const rawRemote = remoteJid ? remoteJid.split('@')[0].split(':')[0] : '';
                const isSelfMessage = (
                    (cleanPhone && botPhone && cleanPhone === botPhone) ||
                    (rawRemote && rawBot && rawRemote === rawBot) ||
                    (instanceObj.user && remoteJid && remoteJid.includes(instanceObj.user.split(':')[0])) ||
                    (instanceObj.user && remoteJid && remoteJid.includes(instanceObj.user.split('@')[0]))
                );

                // Se fromMe for true e NÃO for teste no próprio número, ignora
                if (msg.key.fromMe && !isSelfMessage) {
                    continue;
                }

                const messageText = extractMessageText(msg);
                if (!messageText.trim()) continue;

                // Registra evento de mensagem recebida para auditoria em tempo real
                Logger.log('WHATSAPP_MESSAGE_DETECTED', {
                    instanceId,
                    phone: cleanPhone,
                    text: messageText.substring(0, 60),
                    fromMe: msg.key.fromMe,
                    isSelfMessage
                });

                // Garante que o remote_jid fica salvo para este cliente com IA ativa
                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    remote_jid: remoteJid,
                    phone_raw: rawPhone,
                    from_ad: 1,
                    ai_active: 1
                });

                const bufferKey = `${instanceId}:${cleanPhone}`;

                if (!messageBuffers.has(bufferKey)) {
                    messageBuffers.set(bufferKey, {
                        messages: [messageText],
                        remoteJid: remoteJid,
                        timer: setTimeout(() => handleBufferedMessages(instanceId, cleanPhone, remoteJid), 1200)
                    });
                } else {
                    const current = messageBuffers.get(bufferKey);
                    current.messages.push(messageText);
                    clearTimeout(current.timer);
                    current.timer = setTimeout(() => handleBufferedMessages(instanceId, cleanPhone, remoteJid), 1200);
                }
            }
        });
    } catch (err) {
        console.error(`[${instanceName} START ERROR]`, err);
        instanceObj.status = 'ERROR';
        Logger.log('WHATSAPP_CONNECTION_ERROR', { instanceId, error: err.message });
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
    const list = [];
    const meta = loadInstancesMeta();

    for (let i = 1; i <= MAX_INSTANCES; i++) {
        const id = `instance_${i}`;
        const inst = instances.get(id);
        const name = meta[id]?.name || `WhatsApp ${i}`;

        if (inst) {
            list.push({
                id: inst.id,
                name: inst.name,
                status: inst.status,
                qrCode: inst.qrCode,
                user: inst.user
            });
        } else {
            const authDir = path.join(baseAuthDir, id);
            const hasCreds = fs.existsSync(path.join(authDir, 'creds.json'));
            list.push({
                id,
                name,
                status: hasCreds ? 'CONNECTING' : 'DISCONNECTED',
                qrCode: null,
                user: null
            });
        }
    }
    return list;
}

function getWhatsAppStatus(instanceId = 'instance_1') {
    const inst = instances.get(instanceId);
    if (!inst) {
        return { id: instanceId, status: 'DISCONNECTED', qrCode: null, user: null };
    }
    return {
        id: inst.id,
        name: inst.name,
        status: inst.status,
        qrCode: inst.qrCode,
        user: inst.user
    };
}

async function resetWhatsAppSession(instanceId = 'instance_1') {
    try {
        const inst = instances.get(instanceId);
        if (inst && inst.sock) {
            try {
                await inst.sock.logout();
            } catch (e) {}
            try {
                inst.sock.end();
            } catch (e) {}
        }

        const authDir = path.join(baseAuthDir, instanceId);
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
        await DatabaseService.clearSessionFiles(instanceId);

        const meta = loadInstancesMeta();
        const name = meta[instanceId]?.name || `WhatsApp ${instanceId.replace('instance_', '')}`;
        await startInstance(instanceId, name);

        return true;
    } catch (e) {
        console.error(`[RESET SESSION ERROR ${instanceId}]`, e);
        return false;
    }
}

function renameInstance(instanceId, newName) {
    const meta = loadInstancesMeta();
    meta[instanceId] = { name: newName };
    saveInstancesMeta(meta);

    const inst = instances.get(instanceId);
    if (inst) {
        inst.name = newName;
    }
    return true;
}

async function sendDirectMessage(phone, messageText, instanceId = 'instance_1') {
    const instance = instances.get(instanceId) || instances.get('instance_1');
    if (!instance || !instance.sock || instance.status !== 'CONNECTED') {
        return false;
    }

    let jid = String(phone);
    if (!jid.includes('@')) {
        const clean = DatabaseService.normalizePhone(phone);
        const client = DatabaseService.getClientByPhone(clean);
        jid = (client && client.remote_jid) ? client.remote_jid : `${clean}@s.whatsapp.net`;
    }

    try {
        const sent = await instance.sock.sendMessage(jid, { text: messageText });
        if (sent?.key?.id) {
            sentByBotMessageIds.add(sent.key.id);
            addToProcessedCache(sent.key.id);
        }
        return true;
    } catch (e) {
        console.error(`[DIRECT SEND ERROR to ${phone}]`, e.message);
        return false;
    }
}

module.exports = {
    startWhatsAppBot,
    getAllWhatsAppStatus,
    getWhatsAppStatus,
    resetWhatsAppSession,
    renameInstance,
    sendDirectMessage,
    resolveRealPhone,
    extractMessageText
};
