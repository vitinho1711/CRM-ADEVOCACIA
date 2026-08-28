const OpenAI = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const DatabaseService = require('../database');
const { getSystemPrompt } = require('../systemPrompt');
const { toolDefinitions, executeTool } = require('./tools');
const TriageEngine = require('./triageEngine');
const Logger = require('../logger');

async function processIncomingMessage(phone, userMessageText, instanceId = 'instance_1', remoteJid = null) {
    const cleanPhone = DatabaseService.normalizePhone(phone);
    if (!cleanPhone || !userMessageText || !userMessageText.trim()) return null;

    try {
        // 1. Processa via Motor de Triagem Estruturada
        const triageReply = await TriageEngine.processIncoming(cleanPhone, userMessageText, instanceId, remoteJid);
        if (triageReply) {
            Logger.log('CRM_SYNC_SUCCESS', { phone: cleanPhone, step: 'triage_reply' });
            return triageReply;
        }

        // Se o motor de triagem retornou null, verifica se o cliente tem IA ativa
        const client = DatabaseService.getClientByPhone(cleanPhone);
        if (!client || client.ai_active === 0 || client.from_ad === 0) {
            // Não deve ser atendido pela IA (cliente antigo ou pausado)
            return null;
        }

        // 2. Se está em modo conversacional pós-triagem (ex: tirando dúvidas sobre agendamento)
        const recentMessages = DatabaseService.getRecentMessages(cleanPhone, 15);

        // Se configurado OpenAI
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

                            const toolResult = await executeTool(toolName, toolArgs, cleanPhone);

                            currentMessages.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                content: JSON.stringify(toolResult)
                            });
                        }
                        continue;
                    }

                    const replyText = message.content;
                    if (replyText) {
                        DatabaseService.addMessage(cleanPhone, 'assistant', replyText);
                        Logger.log('CRM_SYNC_SUCCESS', { phone: cleanPhone, action: 'ai_reply' });
                        return replyText;
                    }
                    break;
                }
            } catch (err) {
                console.error('[OPENAI ERROR]', err.message);
                Logger.log('CRM_SYNC_ERROR', { phone: cleanPhone, error: err.message });
            }
        }

        // Se nenhuma resposta anterior gerou texto
        return null;
    } catch (globalErr) {
        console.error('[ORCHESTRATOR ERROR]', globalErr);
        Logger.log('CRM_SYNC_ERROR', { phone: cleanPhone, error: globalErr.message });
        return null;
    }
}

module.exports = { processIncomingMessage };
