const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { processIncomingMessage } = require('../agent/orchestrator');

let sock = null;
let currentQrCode = null;
let connectionStatus = 'disconnected';

// Cache para evitar processar a mesma mensagem duas vezes
const processedMessageIds = new Set();

// Fila de mensagens por telefone (debounce de 1.5s para evitar respostas duplas)
const messageBuffers = new Map(); // phone -> { timer, messages: [], remoteJid }

const authDir = path.join(__dirname, '..', '..', 'data', 'baileys_auth');
if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
}

function addToProcessedCache(id) {
    if (!id) return;
    processedMessageIds.add(id);
    if (processedMessageIds.size > 1000) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
    }
}

async function handleBufferedMessages(phone, remoteJid) {
    const buffer = messageBuffers.get(phone);
    if (!buffer || buffer.messages.length === 0) return;

    const combinedText = buffer.messages.join('\n').trim();
    messageBuffers.delete(phone);

    if (!combinedText) return;

    console.log(`\n📩 [WHATSAPP MENSAGEM RECEBIDA de ${phone}]: "${combinedText}"`);

    try {
        // Envia presença digitando
        await sock.sendPresenceUpdate('composing', remoteJid);
    } catch (e) {}

    // Processa UMA ÚNICA VEZ com a IA
    const reply = await processIncomingMessage(phone, combinedText);

    if (reply && sock && connectionStatus === 'connected') {
        await sock.sendMessage(remoteJid, { text: reply });
        console.log(`🤖 [WHATSAPP RESPOSTA ÚNICA ENVIADA para ${phone}]: "${reply.substring(0, 70)}..."`);
    }
}

async function startWhatsAppBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            auth: state,
            printQRInTerminal: true,
            browser: ['Glaucio Dias Advocacia', 'Chrome', '1.0.0'],
            syncFullHistory: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('\n📱 [NOVO QR CODE GERADO]: Escaneie no Painel Web http://localhost:8000');
                currentQrCode = await QRCode.toDataURL(qr);
                connectionStatus = 'connecting';
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`[WHATSAPP] Conexão encerrada (Status: ${statusCode}). Reconectando: ${shouldReconnect}`);
                connectionStatus = 'disconnected';
                currentQrCode = null;
                if (shouldReconnect) {
                    setTimeout(startWhatsAppBot, 3000);
                }
            } else if (connection === 'open') {
                console.log('\n✅ [WHATSAPP CONECTADO COM SUCESSO!]: Robô Glaucio Dias Advocacia Ativo.');
                connectionStatus = 'connected';
                currentQrCode = null;
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                const msgId = msg.key.id;
                if (processedMessageIds.has(msgId)) {
                    // Mensagem duplicada já processada pelo WhatsApp
                    continue;
                }
                addToProcessedCache(msgId);

                const remoteJid = msg.key.remoteJid || '';
                if (remoteJid.includes('@g.us')) continue; // Ignora grupos

                // Se o próprio bot enviou ou mensagem do próprio usuário
                if (msg.key.fromMe) continue;

                let messageText = '';
                if (msg.message?.conversation) {
                    messageText = msg.message.conversation;
                } else if (msg.message?.extendedTextMessage?.text) {
                    messageText = msg.message.extendedTextMessage.text;
                }

                if (!messageText.trim()) continue;

                const phone = remoteJid.replace('@s.whatsapp.net', '');

                // Debounce de 1.2 segundos para agrupar mensagens rápidas e enviar APENAS UMA resposta
                if (!messageBuffers.has(phone)) {
                    messageBuffers.set(phone, {
                        messages: [messageText],
                        remoteJid: remoteJid,
                        timer: setTimeout(() => handleBufferedMessages(phone, remoteJid), 1200)
                    });
                } else {
                    const current = messageBuffers.get(phone);
                    current.messages.push(messageText);
                    clearTimeout(current.timer);
                    current.timer = setTimeout(() => handleBufferedMessages(phone, remoteJid), 1200);
                }
            }
        });
    } catch (err) {
        console.error('[WHATSAPP START ERROR]', err);
    }
}

function getWhatsAppStatus() {
    return {
        status: connectionStatus,
        qrCode: currentQrCode
    };
}

async function resetWhatsAppSession() {
    console.log('[WHATSAPP] Resetando sessão do WhatsApp...');
    try {
        if (sock) {
            sock.end();
            sock = null;
        }
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
            fs.mkdirSync(authDir, { recursive: true });
        }
        connectionStatus = 'disconnected';
        currentQrCode = null;
        setTimeout(startWhatsAppBot, 1500);
        return true;
    } catch (e) {
        console.error('[RESET SESSION ERROR]', e);
        return false;
    }
}

async function sendDirectMessage(phone, text) {
    if (!sock || connectionStatus !== 'connected') {
        return false;
    }
    const cleanPhone = phone.replace(/\D/g, '');
    const remoteJid = `${cleanPhone}@s.whatsapp.net`;
    await sock.sendMessage(remoteJid, { text });
    return true;
}

module.exports = {
    startWhatsAppBot,
    getWhatsAppStatus,
    resetWhatsAppSession,
    sendDirectMessage
};
