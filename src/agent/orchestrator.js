const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const DatabaseService = require('../database');
const { getSystemPrompt } = require('../systemPrompt');
const { toolDefinitions, executeTool } = require('./tools');

function normalizeText(text) {
    if (!text) return '';
    return text.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove acentos (glaucio -> glaucio)
        .replace(/[.,\-_/]/g, " ")       // Remove pontos e traços (dr. -> dr)
        .replace(/\s+/g, " ")           // Espaços múltiplos
        .trim();
}

function isMessageFromAd(text) {
    if (!text) return false;
    const normalized = normalizeText(text);
    
    // Gatilho oficial prioritário: Dr. Glaucio / Glaucio
    const glaucioPatterns = ['dr glaucio', 'drglaucio', 'doutor glaucio', 'glaucio dias', 'glaucio', 'advogado glaucio'];
    const matchesGlaucio = glaucioPatterns.some(p => normalized.includes(p));
    if (matchesGlaucio) return true;

    // Outros gatilhos configurados no .env
    const keywords = (config.ads.triggerKeywords || []).map(k => normalizeText(k));
    return keywords.some(kw => normalized.includes(kw));
}

async function processIncomingMessage(phone, userMessageText, instanceId = 'instance_1') {
    let client = DatabaseService.getClientByPhone(phone);

    // ========================================================
    // FILTRO DE ANÚNCIOS: Só responde leads que vieram de anúncio
    // ========================================================
    if (config.ads.onlyRespondToAds) {
        if (!client) {
            // Primeiro contato deste número
            const matchedAd = isMessageFromAd(userMessageText);
            if (!matchedAd) {
                console.log(`[FILTRO ANÚNCIOS] Mensagem de ${phone} IGNORADA (Não veio de anúncio): "${userMessageText}"`);
                return null; // Não responde e não cria lead
            }

            console.log(`[FILTRO ANÚNCIOS] Novo lead de ANÚNCIO detectado de ${phone}!`);
            client = DatabaseService.saveOrUpdateClient(phone, {
                instance_id: instanceId,
                status: 'TRIAGEM',
                from_ad: 1,
                ai_active: 1
            });
        } else {
            // Cliente já existe no banco
            if (client.from_ad === 0) {
                // Se não era de anúncio, verifica se agora mandou algo de anúncio
                if (isMessageFromAd(userMessageText)) {
                    DatabaseService.saveOrUpdateClient(phone, { instance_id: instanceId, from_ad: 1, ai_active: 1 });
                    client.from_ad = 1;
                    client.ai_active = 1;
                } else {
                    console.log(`[FILTRO ANÚNCIOS] Mensagem de ${phone} IGNORADA (Contato não é lead de anúncio).`);
                    return null;
                }
            }
        }
    } else {
        if (!client) {
            client = DatabaseService.saveOrUpdateClient(phone, { instance_id: instanceId, status: 'TRIAGEM', ai_active: 1 });
        }
    }

    // Se o atendimento estiver em modo humano
    if (client.ai_active === 0) {
        console.log(`[AGENT] IA pausada para o telefone ${phone} (Em atendimento humano).`);
        return null;
    }

    // 2. Salva a mensagem do usuário no banco
    DatabaseService.addMessage(phone, 'user', userMessageText);

    // 3. Monta o histórico recente
    const recentMessages = DatabaseService.getRecentMessages(phone, 15);

    // ========================================================
    // PROVEDOR 1: GOOGLE GEMINI (Se configurado)
    // ========================================================
    if (config.ai.provider === 'gemini' || config.ai.geminiKey) {
        try {
            const genAI = new GoogleGenerativeAI(config.ai.geminiKey);
            const model = genAI.getGenerativeModel({
                model: 'gemini-1.5-flash',
                systemInstruction: getSystemPrompt()
            });

            const history = recentMessages.slice(0, -1).map(m => ({
                role: m.role === 'user' ? 'user' : 'model',
                parts: [{ text: m.content }]
            }));

            const chat = model.startChat({ history });
            const result = await chat.sendMessage(userMessageText);
            const replyText = result.response.text();

            DatabaseService.addMessage(phone, 'assistant', replyText);
            return replyText;
        } catch (geminiErr) {
            console.error('[GEMINI ERROR]', geminiErr.message);
        }
    }

    // ========================================================
    // PROVEDOR 2: OPENAI (GPT-4o / GPT-4o-mini)
    // ========================================================
    if (config.ai.openaiKey && !config.ai.openaiKey.includes('xxxx')) {
        try {
            const openai = new OpenAI({ apiKey: config.ai.openaiKey });
            let currentMessages = [
                { role: 'system', content: getSystemPrompt() },
                ...recentMessages.map(m => ({
                    role: m.role === 'user' ? 'user' : 'assistant',
                    content: m.content
                }))
            ];

            let iterations = 0;
            const maxIterations = 5;

            while (iterations < maxIterations) {
                iterations++;
                
                const response = await openai.chat.completions.create({
                    model: config.ai.openaiModel || 'gpt-4o-mini',
                    messages: currentMessages,
                    tools: toolDefinitions,
                    tool_choice: 'auto',
                    temperature: 0.7
                });

                const message = response.choices[0].message;

                if (message.tool_calls && message.tool_calls.length > 0) {
                    currentMessages.push(message);

                    for (const toolCall of message.tool_calls) {
                        const toolName = toolCall.function.name;
                        let toolArgs = {};
                        try {
                            toolArgs = JSON.parse(toolCall.function.arguments);
                        } catch (e) {
                            toolArgs = {};
                        }

                        const toolResult = await executeTool(toolName, toolArgs, phone);

                        currentMessages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: JSON.stringify(toolResult)
                        });
                    }
                    continue;
                }

                const replyText = message.content || 'Olá! Como podemos te ajudar hoje?';
                DatabaseService.addMessage(phone, 'assistant', replyText);
                return replyText;
            }
        } catch (err) {
            console.error('[OPENAI ERROR]', err.message);
        }
    }

    const defaultGreeting = `Olá! 👋 Seja bem-vindo(a) ao escritório Glaucio Dias Advocacia. Sou a assistente virtual e estou aqui para entender melhor a sua situação e direcionar o seu atendimento. Para começarmos, poderia me contar brevemente o que aconteceu?`;
    DatabaseService.addMessage(phone, 'assistant', defaultGreeting);
    return defaultGreeting;
}

module.exports = { processIncomingMessage };
