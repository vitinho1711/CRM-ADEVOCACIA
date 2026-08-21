const axios = require('axios');
const config = require('../config');

const EvolutionApi = {
    async sendTextMessage(phone, text) {
        try {
            // Formata número (apenas dígitos)
            const cleanPhone = phone.replace(/\D/g, '');
            const url = `${config.evolution.apiUrl}/message/sendText/${config.evolution.instanceName}`;
            
            const response = await axios.post(url, {
                number: cleanPhone,
                text: text,
                options: {
                    delay: 1200,
                    presence: 'composing'
                }
            }, {
                headers: {
                    'apikey': config.evolution.apiKey,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            });

            return response.data;
        } catch (error) {
            console.error('[EVOLUTION API SEND ERROR]', error.response?.data || error.message);
            return null;
        }
    },

    async sendPresence(phone, presence = 'composing') {
        try {
            const cleanPhone = phone.replace(/\D/g, '');
            const url = `${config.evolution.apiUrl}/chat/sendPresence/${config.evolution.instanceName}`;
            await axios.post(url, {
                number: cleanPhone,
                presence: presence,
                delay: 2000
            }, {
                headers: { 'apikey': config.evolution.apiKey }
            });
        } catch (e) {
            // Silencioso em caso de presença
        }
    },

    // Notificação direta para o WhatsApp do Advogado
    async notifyLawyer(alertMessage) {
        if (!config.office.phone || config.office.phone.includes('999999999')) return;
        return this.sendTextMessage(config.office.phone, `🚨 *ALERTA DO SISTEMA - ${config.office.name}*\n\n${alertMessage}`);
    }
};

module.exports = EvolutionApi;
