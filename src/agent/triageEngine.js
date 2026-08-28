const fs = require('fs');
const path = require('path');
const DatabaseService = require('../database');
const Logger = require('../logger');

const rulesPath = path.join(__dirname, '..', '..', 'data', 'triage_rules.json');

function loadRules() {
    try {
        if (fs.existsSync(rulesPath)) {
            const raw = fs.readFileSync(rulesPath, 'utf8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error('[TRIAGE RULES LOAD ERROR]', e);
    }
    return {
        ad_triggers: ['dr glaucio', 'anuncio', 'instagram', 'facebook', 'patrocinado'],
        niches: {},
        score_ranges: []
    };
}

function normalize(text) {
    if (!text) return '';
    return String(text).toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[.,\-_/]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isAdMessage(text) {
    if (!text) return false;
    const norm = normalize(text);
    const rules = loadRules();
    const triggers = rules.ad_triggers || [];
    return triggers.some(trig => norm.includes(normalize(trig)));
}

function detectNicheFromText(text) {
    const norm = normalize(text);
    if (['demissao', 'demitido', 'trabalho', 'patrao', 'fgts', 'horas extras', 'trabalhista', 'carteira assinada', 'rescisao'].some(k => norm.includes(k))) {
        return 'trabalhista';
    }
    if (['inss', 'aposentadoria', 'beneficio', 'bpc', 'loas', 'auxilio doenca', 'previdenciario'].some(k => norm.includes(k))) {
        return 'previdenciario';
    }
    if (['divorcio', 'separacao', 'guarda', 'pensao', 'partilha', 'familia', 'inventario', 'alimentos'].some(k => norm.includes(k))) {
        return 'familia';
    }
    if (['golpe', 'pix', 'fraude', 'bancario', 'juros abusivos', 'emprestimo consignado', 'serasa', 'spc', 'negativado'].some(k => norm.includes(k))) {
        return 'bancario_consumidor';
    }
    return null;
}

function matchOption(options, userText) {
    if (!options || options.length === 0) return null;
    const norm = normalize(userText);

    // 1. Procura por alias exato ou número
    for (const opt of options) {
        if (opt.aliases) {
            for (const alias of opt.aliases) {
                const normAlias = normalize(alias);
                if (norm === normAlias || norm.startsWith(normAlias + ' ') || norm.endsWith(' ' + normAlias) || norm.includes(normAlias)) {
                    return opt;
                }
            }
        }
        if (norm.includes(normalize(opt.text))) {
            return opt;
        }
    }

    // 2. Se o usuário digitou texto aberto, tenta associar por relevância
    for (const opt of options) {
        const words = normalize(opt.text).split(' ');
        if (words.some(w => w.length > 3 && norm.includes(w))) {
            return opt;
        }
    }

    return null;
}

const TriageEngine = {
    isAdMessage,
    loadRules,

    async processIncoming(phone, messageText, instanceId = 'instance_1') {
        const cleanPhone = DatabaseService.normalizePhone(phone);
        let client = DatabaseService.getClientByPhone(cleanPhone);
        const rules = loadRules();

        Logger.log('LEAD_RECEIVED', {
            phone: cleanPhone,
            message: messageText.substring(0, 80),
            instanceId,
            existingLead: !!client
        });

        // ========================================================
        // REGRA DE OURO: IA RESPONDE EXCLUSIVAMENTE ANÚNCIOS
        // CLIENTES ANTIGOS OU CONTATOS PESSOAIS NUNCA SÃO RESPONDIDOS
        // ========================================================
        if (client) {
            // Contato já existe
            if (client.from_ad === 0 || client.ai_active === 0) {
                console.log(`[BLOQUEIO IA] ${cleanPhone} é contato antigo/orgânico ou atendimento humano. IA permanece em silêncio.`);
                return null;
            }
        } else {
            // Contato novo: Checa rigorosamente se veio de anúncio
            const isFromAd = isAdMessage(messageText);
            if (!isFromAd) {
                console.log(`[BLOQUEIO IA] Mensagem de ${cleanPhone} NÃO é de anúncio. IA não responde.`);
                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    instance_id: instanceId,
                    from_ad: 0,
                    ai_active: 0,
                    status: 'NÃO QUALIFICADO',
                    source: 'organico_ou_pessoal'
                });
                return null;
            }

            // É NOVO LEAD DE ANÚNCIO: Cria imediatamente
            console.log(`🎯 [NOVO LEAD DE ANÚNCIO DETECTADO] ${cleanPhone}`);
            client = DatabaseService.saveOrUpdateClient(cleanPhone, {
                instance_id: instanceId,
                from_ad: 1,
                ai_active: 1,
                status: 'NOVO LEAD',
                source: 'anuncio',
                triage_step: 'area_selection'
            });

            Logger.log('LEAD_CREATED', {
                phone: cleanPhone,
                source: 'anuncio',
                instanceId
            });
        }

        // Salva a mensagem recebida no histórico
        DatabaseService.addMessage(cleanPhone, 'user', messageText);

        // Se o atendimento estiver em modo humano
        if (client.ai_active === 0) {
            console.log(`[AGENT] IA pausada para ${cleanPhone} (Em atendimento humano).`);
            return null;
        }

        const currentStepId = client.triage_step || 'area_selection';

        // ========================================================
        // ETAPA 1: SELEÇÃO DA ÁREA JURÍDICA
        // ========================================================
        if (currentStepId === 'area_selection') {
            Logger.log('TRIAGE_STARTED', { phone: cleanPhone });

            // Tenta detectar direto da mensagem (ex: se o anúncio já veio com texto específico)
            let detectedNiche = detectNicheFromText(messageText);
            let matchedOption = matchOption(rules.initial_step.options, messageText);

            if (matchedOption) {
                detectedNiche = matchedOption.id;
            }

            if (detectedNiche && rules.niches[detectedNiche]) {
                const nicheConfig = rules.niches[detectedNiche];
                const firstStep = nicheConfig.steps[0];

                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    law_area: nicheConfig.name,
                    triage_step: firstStep ? firstStep.id : 'completed',
                    status: 'EM TRIAGEM'
                });

                Logger.log('TRIAGE_ANSWER_SAVED', {
                    phone: cleanPhone,
                    step: 'area_selection',
                    area: nicheConfig.name
                });

                const reply = `Perfeito! Para que nossa equipe do **${nicheConfig.name}** possa analisar sua causa:\n\n${firstStep ? firstStep.question : 'Poderia descrever brevemente sua situação?'}`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            } else {
                // Não identificou a área: Envia a pergunta com opções claras
                const reply = rules.initial_step.question;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }
        }

        // ========================================================
        // ETAPA 2: FLUXO ESPECÍFICO DO NICHO
        // ========================================================
        // Descobre qual nicho o cliente pertence
        let currentNicheKey = null;
        let currentStepObj = null;
        let currentStepIndex = -1;

        for (const [key, niche] of Object.entries(rules.niches)) {
            const idx = (niche.steps || []).findIndex(s => s.id === currentStepId);
            if (idx >= 0) {
                currentNicheKey = key;
                currentStepObj = niche.steps[idx];
                currentStepIndex = idx;
                break;
            }
        }

        if (currentStepObj && currentNicheKey) {
            const niche = rules.niches[currentNicheKey];
            const matched = matchOption(currentStepObj.options, messageText);

            const chosenAnswer = matched ? matched.text : messageText.trim();
            const points = matched ? (matched.points || 15) : 10;

            const nextStepObj = niche.steps[currentStepIndex + 1] || null;
            const nextStepId = nextStepObj ? nextStepObj.id : 'completed';

            // Salva a resposta imediatamente de forma atômica
            client = DatabaseService.saveTriageAnswer(
                cleanPhone,
                currentStepObj.id,
                currentStepObj.question.split('\n')[0],
                chosenAnswer,
                points,
                nextStepId
            );

            Logger.log('TRIAGE_ANSWER_SAVED', {
                phone: cleanPhone,
                step: currentStepObj.id,
                answer: chosenAnswer,
                points,
                currentScore: client.qualification_score
            });

            // Se ainda houver próxima pergunta no nicho
            if (nextStepObj) {
                const reply = nextStepObj.question;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            } else {
                // Triagem do nicho CONCLUÍDA!
                Logger.log('TRIAGE_COMPLETED', {
                    phone: cleanPhone,
                    score: client.qualification_score,
                    status: client.qualification_status
                });

                Logger.log('LEAD_QUALIFIED', {
                    phone: cleanPhone,
                    score: client.qualification_score,
                    qualificationStatus: client.qualification_status
                });

                let reply = '';
                if (client.qualification_score >= 60) {
                    reply = `Excelente! Suas respostas foram salvas e seu atendimento foi classificado como **${client.qualification_status}** para a equipe do Dr. Glaucio Dias. ⚖️\n\nGostaria de agendar uma reunião para tirar dúvidas e traçar os próximos passos da sua causa?\n\n🏢 **Presencial:** Av. Abílio Machado, 1380 - Alípio de Melo (BH)\n📹 **Online:** Via Google Meet`;
                } else {
                    reply = `Obrigado por responder a todas as perguntas! Suas informações foram registradas no nosso sistema com sucesso. 📋\n\nNossa equipe jurídica analisará os dados do seu caso e retornará por aqui assim que possível. Se tiver urgência, pode deixar uma mensagem que nosso plantão responderá.`;
                }

                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }
        }

        // Se já concluiu a triagem ou respondeu em formato livre após término
        return null;
    }
};

module.exports = TriageEngine;
