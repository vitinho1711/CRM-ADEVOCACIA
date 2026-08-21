const axios = require('axios');

async function testFlow() {
    console.log('--- Testando Simulação de Mensagem WhatsApp ---');
    const webhookUrl = 'http://localhost:8000/webhook/evolution';

    const payload = {
        event: 'messages.upsert',
        data: {
            key: {
                remoteJid: '5531988776655@s.whatsapp.net',
                fromMe: false
            },
            message: {
                conversation: 'Olá, fui demitido sem justa causa há um mês e não recebi a rescisão. Meu nome é Vitor Batista.'
            }
        }
    };

    const res = await axios.post(webhookUrl, payload);
    console.log('Webhook Status:', res.status, res.data);

    // Aguarda 1 segundo
    await new Promise(r => setTimeout(r, 1000));

    const leadsRes = await axios.get('http://localhost:8000/api/leads');
    console.log('\n--- Leads no CRM ---');
    console.log(JSON.stringify(leadsRes.data, null, 2));

    const chatRes = await axios.get('http://localhost:8000/api/chat/5531988776655');
    console.log('\n--- Histórico de Mensagens ---');
    console.log(JSON.stringify(chatRes.data, null, 2));
}

testFlow().catch(console.error);
