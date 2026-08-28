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

    for (const opt of options) {
        const words = normalize(opt.text).split(' ');
        if (words.some(w => w.length > 3 && norm.includes(w))) {
            return opt;
        }
    }

    return null;
}

function getNextBusinessDayFormatted() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1); // se domingo -> segunda
    if (d.getDay() === 6) d.setDate(d.getDate() + 2); // se sábado -> segunda

    const dia = String(d.getDate()).padStart(2, '0');
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const ano = d.getFullYear();
    const diasSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

    return {
        iso: `${ano}-${mes}-${dia}`,
        display: `${diasSemana[d.getDay()]}, ${dia}/${mes}/${ano}`
    };
}

const TriageEngine = {
    isAdMessage,
    loadRules,

    async processIncoming(phone, messageText, instanceId = 'instance_1') {
        const cleanPhone = DatabaseService.normalizePhone(phone);
        let client = DatabaseService.getClientByPhone(cleanPhone);
        const rules = loadRules();
        const normMsg = normalize(messageText);

        Logger.log('LEAD_RECEIVED', {
            phone: cleanPhone,
            message: messageText.substring(0, 80),
            instanceId,
            existingLead: !!client
        });

        // ========================================================
        // REGRA DE OURO: IA RESPONDE EXCLUSIVAMENTE ANÚNCIOS
        // ========================================================
        if (client) {
            if (client.from_ad === 0 || client.ai_active === 0) {
                console.log(`[BLOQUEIO IA] ${cleanPhone} é contato antigo/orgânico ou humano. IA em silêncio.`);
                return null;
            }
        } else {
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

            console.log(`🎯 [NOVO LEAD DE ANÚNCIO DETECTADO] ${cleanPhone}`);
            client = DatabaseService.saveOrUpdateClient(cleanPhone, {
                instance_id: instanceId,
                from_ad: 1,
                ai_active: 1,
                status: 'NOVO LEAD',
                source: 'anuncio',
                triage_step: 'area_selection'
            });

            Logger.log('LEAD_CREATED', { phone: cleanPhone, source: 'anuncio', instanceId });
        }

        // Salva a mensagem recebida no histórico
        DatabaseService.addMessage(cleanPhone, 'user', messageText);

        if (client.ai_active === 0) {
            return null;
        }

        const currentStepId = client.triage_step || 'area_selection';

        // ========================================================
        // ETAPA 1: SELEÇÃO DA ÁREA JURÍDICA
        // ========================================================
        if (currentStepId === 'area_selection') {
            Logger.log('TRIAGE_STARTED', { phone: cleanPhone });

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
                    triage_step: firstStep ? firstStep.id : 'scheduling_format',
                    status: 'EM TRIAGEM'
                });

                Logger.log('TRIAGE_ANSWER_SAVED', {
                    phone: cleanPhone,
                    step: 'area_selection',
                    area: nicheConfig.name
                });

                const reply = `Excelente! O escritório Glaucio Dias Advocacia é especialista em **${nicheConfig.name}**. ⚖️\n\nPara que possamos esclarecer sua situação e preparar seu atendimento com o advogado:\n\n${firstStep ? firstStep.question : 'Poderia me contar brevemente o que aconteceu?'}`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            } else {
                const reply = rules.initial_step.question;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }
        }

        // ========================================================
        // ETAPA DE FECHAMENTO 1: ESCOLHA DO FORMATO DA REUNIÃO
        // ========================================================
        if (currentStepId === 'scheduling_format') {
            const isOnline = ['1', 'online', 'meet', 'video', 'chamada', 'distancia'].some(k => normMsg.includes(k));
            const isPresencial = ['2', 'presencial', 'escritorio', 'pessoalmente', 'bh', 'abilio'].some(k => normMsg.includes(k));

            let chosenFormat = 'Online (Google Meet)';
            if (isPresencial && !isOnline) {
                chosenFormat = 'Presencial';
            }

            const nextDay = getNextBusinessDayFormatted();

            DatabaseService.saveOrUpdateClient(cleanPhone, {
                triage_step: 'scheduling_slot',
                summary: `Formato escolhido: ${chosenFormat}. Caso em agendamento com Dr. Glaucio.`
            });

            let reply = '';
            if (chosenFormat === 'Presencial') {
                reply = `Perfeito! Será um grande prazer recebê-lo(a) pessoalmente em nosso escritório na **Av. Abílio Machado, 1380 - Alípio de Melo (Belo Horizonte / MG)**. 🏢\n\nTemos estes horários disponíveis na agenda do Dr. Glaucio Dias para **${nextDay.display}**:\n\n1️⃣ **10:00**\n2️⃣ **14:30**\n3️⃣ **16:30**\n\nQual desses horários fica melhor para você? (Ou pode me sugerir outro horário de sua preferência!)`;
            } else {
                reply = `Excelente! O atendimento **Online pelo Google Meet** é muito prático e seguro: você fala diretamente com o Dr. Glaucio Dias pelo celular ou computador, sem precisar pegar trânsito. 📹\n\nTemos estes horários livres para **${nextDay.display}**:\n\n1️⃣ **10:00**\n2️⃣ **14:30**\n3️⃣ **16:30**\n\nQual desses horários você prefere? (Ou pode me sugerir outro horário!)`;
            }

            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

        // ========================================================
        // ETAPA DE FECHAMENTO 2: CONFIRMAÇÃO DO HORÁRIO DA REUNIÃO
        // ========================================================
        if (currentStepId === 'scheduling_slot') {
            const nextDay = getNextBusinessDayFormatted();
            let chosenTime = '14:30';

            if (['1', '10', '10h', '10:00', 'manha', 'manhã'].some(k => normMsg.includes(k))) {
                chosenTime = '10:00';
            } else if (['2', '14', '14h', '14:30', 'duas'].some(k => normMsg.includes(k))) {
                chosenTime = '14:30';
            } else if (['3', '16', '16h', '16:30', 'quatro'].some(k => normMsg.includes(k))) {
                chosenTime = '16:30';
            } else {
                // Tenta capturar qualquer horário digitado pelo usuário (ex: 15h, 11:00)
                const timeMatch = messageText.match(/(\d{1,2})[:hH](\d{2})?/);
                if (timeMatch) {
                    const hour = timeMatch[1].padStart(2, '0');
                    const min = timeMatch[2] || '00';
                    chosenTime = `${hour}:${min}`;
                }
            }

            const meetingType = client.summary?.includes('Presencial') ? 'Presencial' : 'Online (Google Meet)';

            // Cria oficialmente a reunião no banco de dados e agenda do CRM
            const appointment = DatabaseService.createAppointment({
                phone: cleanPhone,
                name: client.name || 'Cliente (Novo Lead)',
                date: nextDay.iso,
                time: chosenTime,
                meeting_type: meetingType,
                law_area: client.law_area || 'Direito Geral',
                summary: `Reunião agendada via Triagem WhatsApp para tratar do caso de ${client.law_area || 'área jurídica'}. Score: ${client.qualification_score}/100.`
            });

            DatabaseService.saveOrUpdateClient(cleanPhone, {
                triage_step: 'completed',
                status: 'AGENDADO'
            });

            Logger.log('CRM_SYNC_SUCCESS', {
                phone: cleanPhone,
                action: 'appointment_created',
                appointmentId: appointment.id
            });

            let reply = '';
            if (meetingType === 'Presencial') {
                reply = `🎉 **Reunião confirmada com sucesso com o Dr. Glaucio Dias!**\n\n📅 **Data:** ${nextDay.display}\n🕒 **Horário:** ${chosenTime}\n📍 **Local:** Av. Abílio Machado, 1380 - Alípio de Melo, Belo Horizonte / MG\n🗺️ **Rota:** https://maps.google.com/?q=Av.+Ab%C3%ADlio+Machado,+1380+-+Al%C3%ADpio+de+Melo\n⚖️ **Advogado Responsável:** Dr. Glaucio Dias\n\nJá reservei esse horário exclusivo na agenda. Por favor, traga seus documentos e registros para analisarmos juntos. Se tiver qualquer imprevisto, avise por aqui. Te esperamos!`;
            } else {
                reply = `🎉 **Reunião Online confirmada com sucesso com o Dr. Glaucio Dias!**\n\n📅 **Data:** ${nextDay.display}\n🕒 **Horário:** ${chosenTime}\n📹 **Formato:** Online (Google Meet)\n🔗 **Link da Reunião:** https://meet.google.com/glaucio-advocacia\n⚖️ **Advogado Responsável:** Dr. Glaucio Dias\n\nJá reservei seu horário na agenda do Dr. Glaucio. No horário marcado, basta clicar no link acima para falar diretamente com o advogado. Qualquer dúvida até lá, estou à disposição por aqui!`;
            }

            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

        // ========================================================
        // ETAPA 2: FLUXO DE PERGUNTAS DO NICHO (ESCLARECER O CASO)
        // ========================================================
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
            const points = matched ? (matched.points || 20) : 15;

            const nextStepObj = niche.steps[currentStepIndex + 1] || null;
            // Se não houver mais perguntas no nicho, o PRÓXIMO PASSO OBRIGATÓRIO É O AGENDAMENTO DA REUNIÃO!
            const nextStepId = nextStepObj ? nextStepObj.id : 'scheduling_format';

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

            if (nextStepObj) {
                // Próxima pergunta de aprofundamento da causa
                const reply = nextStepObj.question;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            } else {
                // CONCLUIU O QUESTIONÁRIO DO NICHO -> CONDUÇÃO IMEDIATA PARA A REUNIÃO!
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

                // Mensagem de valorização do caso e ponte direta para a reunião
                const reply = `Entendido perfeitamente! Com base em todos os dados que você me passou, seu caso tem pontos jurídicos muito importantes e prazos que precisam de atenção rápida para resguardar seus direitos.\n\nO objetivo agora é esclarecer tudo em detalhes, fazer os cálculos e traçar a melhor estratégia diretamente em uma **reunião com o Dr. Glaucio Dias**. ⚖️\n\nComo fica mais prático e confortável para você?\n\n1️⃣ **Online (via Google Meet)** — Prático, seguro e sem trânsito\n2️⃣ **Presencial** — Em nosso escritório na Av. Abílio Machado, 1380 - Alípio de Melo (BH)`;

                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }
        }

        return null;
    }
};

module.exports = TriageEngine;
