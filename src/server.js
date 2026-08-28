const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const DatabaseService = require('./database');
const { processIncomingMessage } = require('./agent/orchestrator');
const EvolutionApi = require('./integrations/evolutionApi');
const { startWhatsAppBot, getAllWhatsAppStatus, getWhatsAppStatus, resetWhatsAppSession, renameInstance, sendDirectMessage } = require('./integrations/whatsappDirect');
const Logger = require('./logger');

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
        version: '2.1.0'
    });
});

// ====================================================
// ROTAS DE STATUS MULTI-INSTÂNCIA DO WHATSAPP (ATÉ 5 NÚMEROS)
// ====================================================
app.get('/api/whatsapp/instances', (req, res) => {
    res.json(getAllWhatsAppStatus());
});

app.get('/api/whatsapp/status', (req, res) => {
    res.json(getWhatsAppStatus(req.query.instance || 'instance_1'));
});

app.post('/api/whatsapp/instances/:id/reset', async (req, res) => {
    const success = await resetWhatsAppSession(req.params.id);
    res.json({ success });
});

app.post('/api/whatsapp/instances/:id/rename', (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const success = renameInstance(req.params.id, name);
    res.json({ success });
});

app.post('/api/whatsapp/reset', async (req, res) => {
    const success = await resetWhatsAppSession('instance_1');
    res.json({ success });
});

// ====================================================
// ROTAS DE MÉTRICAS & QUALIFICAÇÃO
// ====================================================
app.get('/api/metrics', (req, res) => {
    try {
        const metrics = DatabaseService.getLeadMetrics();
        res.json(metrics);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ====================================================
// REGRAS DE TRIAGEM & PONTUAÇÃO CONFIGURÁVEIS
// ====================================================
const rulesPath = path.join(__dirname, '..', 'data', 'triage_rules.json');

app.get('/api/triage-rules', (req, res) => {
    try {
        if (fs.existsSync(rulesPath)) {
            const raw = fs.readFileSync(rulesPath, 'utf8');
            return res.json(JSON.parse(raw));
        }
        res.json({});
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/triage-rules', (req, res) => {
    try {
        const newRules = req.body;
        if (!newRules || typeof newRules !== 'object') {
            return res.status(400).json({ error: 'Formato de regras inválido' });
        }
        fs.writeFileSync(rulesPath, JSON.stringify(newRules, null, 2), 'utf8');
        res.json({ success: true, message: 'Regras de triagem atualizadas com sucesso' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Logs de auditoria interna
app.get('/api/audit-logs', (req, res) => {
    const logs = Logger.getRecentLogs(100);
    res.json(logs);
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

            console.log(`[WHATSAPP EVOLUTION MESSAGE from ${phone}]: ${messageText}`);
            await EvolutionApi.sendPresence(phone, 'composing');

            const reply = await processIncomingMessage(phone, messageText);
            if (reply) {
                await EvolutionApi.sendTextMessage(phone, reply);
            }
        }
    } catch (error) {
        console.error('[WEBHOOK ERROR]', error);
        Logger.log('CRM_SYNC_ERROR', { error: error.message });
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
    let csv = 'Nome,Telefone,Email,Cidade,Area_Juridica,Status,Score,Qualificacao,Origem,Campanha,Criado_Em\n';
    
    clients.forEach(c => {
        const name = (c.name || 'Cliente').replace(/,/g, ' ');
        const phone = (c.phone || '').replace(/,/g, ' ');
        const email = (c.email || '').replace(/,/g, ' ');
        const city = (c.city || '').replace(/,/g, ' ');
        const area = (c.law_area || '').replace(/,/g, ' ');
        const status = (c.status || '').replace(/,/g, ' ');
        const score = c.qualification_score || 0;
        const qual = (c.qualification_status || '').replace(/,/g, ' ');
        const source = (c.source || '').replace(/,/g, ' ');
        const camp = (c.campaign || '').replace(/,/g, ' ');
        const date = (c.created_at || '').substring(0, 10);
        csv += `"${name}","${phone}","${email}","${city}","${area}","${status}",${score},"${qual}","${source}","${camp}","${date}"\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="leads_qualificados_glaucio_advocacia.csv"');
    res.send('\uFEFF' + csv);
});

app.get('/api/manual-pdf', (req, res) => {
    const pdfPath = path.join(__dirname, '..', 'Manual_Completo_CRM_Glaucio_Advocacia.pdf');
    if (fs.existsSync(pdfPath)) {
        res.download(pdfPath, 'Manual_Completo_CRM_Glaucio_Advocacia.pdf');
    } else {
        res.status(404).send('PDF em geração.');
    }
});

app.get('/api/appointments', (req, res) => {
    const appointments = DatabaseService.getAllAppointments();
    res.json(appointments);
});

app.post('/api/appointments/create', (req, res) => {
    const { name, phone, email, date, time, meeting_type, law_area, summary } = req.body;
    if (!name || !phone || !date || !time) {
        return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
    }
    const appt = DatabaseService.createAppointment({
        name,
        phone,
        email,
        date,
        time,
        meeting_type: meeting_type || 'Presencial',
        law_area: law_area || 'Direito Geral',
        summary: summary || 'Reunião agendada pelo advogado'
    });
    res.json({ success: true, appointment: appt });
});

// DISPARO DE FOLLOW-UP / LEMBRETE NO WHATSAPP DO CLIENTE
app.post('/api/appointments/:id/follow-up', async (req, res) => {
    try {
        const appts = DatabaseService.getAllAppointments();
        const appt = appts.find(a => a.id == req.params.id);
        if (!appt) return res.status(404).json({ error: 'Reunião não encontrada' });

        const isOnline = (appt.meeting_type || '').includes('Online');
        const meetText = isOnline 
            ? `📹 Link do Google Meet: ${appt.meet_link || 'https://meet.google.com/glaucio-advocacia'}`
            : `📍 Endereço Presencial: Av. Abílio Machado, 1380 - Alípio de Melo, Belo Horizonte / MG`;

        const followupMsg = `Olá, ${appt.client_name}! 👋⚖️\n\nPassando para confirmar sua reunião com o **Dr. Glaucio Dias**:\n\n📅 **Data:** ${appt.date}\n🕒 **Horário:** ${appt.time}\n${meetText}\n\n📌 **Orientações:**\nPor favor, deixe separados seus documentos e registros para analisarmos juntos. Se precisar de qualquer ajuste no horário, basta responder esta mensagem. Até breve!`;

        DatabaseService.addMessage(appt.client_phone, 'assistant', followupMsg);
        DatabaseService.registerFollowUpSent(appt.id);

        const sent = await sendDirectMessage(appt.client_phone, followupMsg);
        if (!sent) {
            await EvolutionApi.sendTextMessage(appt.client_phone, followupMsg);
        }

        res.json({ success: true, message: 'Follow-up de confirmação enviado com sucesso no WhatsApp!' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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

// ====================================================
// ROTAS DE BACKUP E DOWNLOAD DO BANCO DE DADOS SQLITE
// ====================================================
app.get('/api/database/backup', (req, res) => {
    const result = DatabaseService.createDatabaseBackup();
    res.json(result);
});

app.get('/api/database/download', (req, res) => {
    if (fs.existsSync(DatabaseService.sqliteFile)) {
        res.download(DatabaseService.sqliteFile, 'crm_advocacia.sqlite');
    } else {
        res.status(404).send('Banco de dados não encontrado.');
    }
});

// Link oficial da Sala do Google Meet
app.get('/api/office/meet-link', (req, res) => {
    res.json({ meet_link: DatabaseService.getOfficeMeetLink() });
});

app.post('/api/office/meet-link', (req, res) => {
    const { meet_link } = req.body;
    if (!meet_link || !meet_link.startsWith('http')) {
        return res.status(400).json({ error: 'Link do Google Meet inválido' });
    }
    const success = DatabaseService.setOfficeMeetLink(meet_link.trim());
    res.json({ success, meet_link: DatabaseService.getOfficeMeetLink() });
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

    // Dispara primeiro ping de keep-alive 30s após subir
    setTimeout(triggerKeepAlivePing, 30000);
});

// ====================================================
// ROBÔ DESPERTADOR (KEEP-ALIVE 24H): Impede repouso do Render
// ====================================================
const https = require('https');
const RENDER_PUBLIC_URL = 'https://crm-adevocacia.onrender.com/health';

function triggerKeepAlivePing() {
    try {
        https.get(RENDER_PUBLIC_URL, (res) => {
            console.log(`[KEEP-ALIVE 24H] Ping enviado para manter servidor acordado. Status: ${res.statusCode}`);
        }).on('error', () => {});
    } catch (e) {}
}

// Dispara a cada 8 minutos (480.000 ms) para nunca atingir os 15 min de inatividade
setInterval(triggerKeepAlivePing, 8 * 60 * 1000);

