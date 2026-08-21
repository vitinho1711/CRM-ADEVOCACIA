const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const DatabaseService = require('./database');
const { processIncomingMessage } = require('./agent/orchestrator');
const EvolutionApi = require('./integrations/evolutionApi');
const { startWhatsAppBot, getWhatsAppStatus, resetWhatsAppSession, sendDirectMessage } = require('./integrations/whatsappDirect');

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// Servir arquivos estáticos do Dashboard
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rota de Saúde
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        service: config.office.name,
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// ====================================================
// ROTAS DE STATUS DO WHATSAPP (QR CODE)
// ====================================================
app.get('/api/whatsapp/status', (req, res) => {
    res.json(getWhatsAppStatus());
});

app.post('/api/whatsapp/reset', async (req, res) => {
    const success = await resetWhatsAppSession();
    res.json({ success });
});

// ====================================================
// WEBHOOK RECEIVER DA EVOLUTION API (WHATSAPP EXTERNO)
// ====================================================
app.post('/webhook/evolution', async (req, res) => {
    res.status(200).json({ received: true });

    try {
        const body = req.body;
        if (body.event === 'messages.upsert') {
            const data = body.data;
            if (!data || data.key?.fromMe) return;

            const remoteJid = data.key?.remoteJid || '';
            if (remoteJid.includes('@g.us')) return;

            const phone = remoteJid.replace('@s.whatsapp.net', '');
            
            let messageText = '';
            if (data.message?.conversation) {
                messageText = data.message.conversation;
            } else if (data.message?.extendedTextMessage?.text) {
                messageText = data.message.extendedTextMessage.text;
            } else if (data.message?.audioMessage) {
                messageText = '[Áudio recebido do cliente]';
            }

            if (!messageText.trim()) return;

            console.log(`[WHATSAPP MESSAGE from ${phone}]: ${messageText}`);
            await EvolutionApi.sendPresence(phone, 'composing');

            const reply = await processIncomingMessage(phone, messageText);
            if (reply) {
                await EvolutionApi.sendTextMessage(phone, reply);
            }
        }
    } catch (error) {
        console.error('[WEBHOOK ERROR]', error);
    }
});

// ====================================================
// ROTAS DE API PARA O DASHBOARD ADMINISTRATIVO
// ====================================================
app.get('/api/leads', (req, res) => {
    const clients = DatabaseService.getAllClients();
    res.json(clients);
});

app.get('/api/export-leads', (req, res) => {
    const clients = DatabaseService.getAllClients();
    let csv = 'Nome,Telefone,Cidade,Area_Juridica,Status,Resumo,Criado_Em\n';
    
    clients.forEach(c => {
        const name = (c.name || 'Cliente').replace(/,/g, ' ');
        const phone = (c.phone || '').replace(/,/g, ' ');
        const city = (c.city || '').replace(/,/g, ' ');
        const area = (c.law_area || '').replace(/,/g, ' ');
        const status = (c.status || '').replace(/,/g, ' ');
        const summary = (c.summary || '').replace(/[\r\n,]/g, ' ');
        const date = (c.created_at || '').substring(0, 10);
        csv += `"${name}","${phone}","${city}","${area}","${status}","${summary}","${date}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_glaucio_advocacia.csv"');
    res.send('\uFEFF' + csv);
});

// Download do Manual Completo do CRM em PDF
app.get('/api/manual-pdf', (req, res) => {
    const pdfPath = path.join(__dirname, '..', 'Manual_Completo_CRM_Glaucio_Advocacia.pdf');
    if (fs.existsSync(pdfPath)) {
        res.download(pdfPath, 'Manual_Completo_CRM_Glaucio_Advocacia.pdf');
    } else {
        res.status(404).send('PDF em geração. Tente novamente em alguns segundos.');
    }
});

app.get('/api/appointments', (req, res) => {
    const appointments = DatabaseService.getAllAppointments();
    res.json(appointments);
});

app.post('/api/appointments/:id/cancel', (req, res) => {
    const success = DatabaseService.cancelAppointment(req.params.id);
    res.json({ success });
});

// Excluir um contato/lead específico
app.post('/api/leads/:phone/delete', (req, res) => {
    const success = DatabaseService.deleteClient(req.params.phone);
    res.json({ success });
});

app.delete('/api/leads/:phone', (req, res) => {
    const success = DatabaseService.deleteClient(req.params.phone);
    res.json({ success });
});

// Limpar todos os contatos e leads
app.post('/api/leads/clear-all', (req, res) => {
    const success = DatabaseService.clearAllClients();
    res.json({ success });
});

app.get('/api/chat/:phone', (req, res) => {
    const messages = DatabaseService.getRecentMessages(req.params.phone, 50);
    res.json(messages);
});

app.post('/api/leads/:phone/toggle-ai', (req, res) => {
    const { active } = req.body;
    DatabaseService.setAiActive(req.params.phone, active);
    res.json({ success: true, ai_active: active });
});

app.post('/api/send-manual-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Telefone e mensagem são obrigatórios' });

    DatabaseService.addMessage(phone, 'assistant', message);
    
    const sentDirect = await sendDirectMessage(phone, message);
    if (!sentDirect) {
        await EvolutionApi.sendTextMessage(phone, message);
    }
    res.json({ success: true });
});

// Inicia o servidor e o bot do WhatsApp
const PORT = config.server.port;
app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 Servidor ${config.office.name} Online!`);
    console.log(`🌐 Painel Dashboard: http://localhost:${PORT}`);
    console.log(`==================================================`);
    
    startWhatsAppBot().catch(err => {
        console.error('[WHATSAPP START ERROR]', err);
    });
});
