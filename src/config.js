const dotenv = require('dotenv');
dotenv.config();

module.exports = {
    office: {
        name: process.env.OFFICE_NAME || 'Glaucio Dias Advocacia',
        lawyerName: process.env.LAWYER_NAME || 'Dr. Glaucio Dias',
        phone: process.env.OFFICE_PHONE || '5531999999999',
        city: process.env.OFFICE_CITY || 'Belo Horizonte / MG',
        address: process.env.OFFICE_ADDRESS || 'Av. Abílio Machado, 1380 - Alípio de Melo',
        hoursStart: process.env.BUSINESS_HOURS_START || '09:00',
        hoursEnd: process.env.BUSINESS_HOURS_END || '18:00'
    },
    ai: {
        provider: process.env.AI_PROVIDER || 'openai',
        openaiKey: process.env.OPENAI_API_KEY || '',
        openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        geminiKey: process.env.GEMINI_API_KEY || ''
    },
    evolution: {
        apiUrl: (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/+$/, ''),
        apiKey: process.env.EVOLUTION_API_KEY || 'sua_chave_global_aqui',
        instanceName: process.env.EVOLUTION_INSTANCE_NAME || 'glaucio_advocacia'
    },
    server: {
        port: parseInt(process.env.PORT || '8000', 10),
        secretWebhookKey: process.env.SECRET_WEBHOOK_KEY || 'advocacia_segura_2026'
    },
    ads: {
        onlyRespondToAds: (process.env.ONLY_RESPOND_TO_ADS || 'true').toLowerCase() === 'true',
        triggerKeywords: (process.env.AD_TRIGGER_KEYWORDS || 'anúncio,anuncio,instagram,facebook,patrocinado,gostaria de saber mais')
            .split(',')
            .map(k => k.trim().toLowerCase())
            .filter(Boolean)
    }
};
