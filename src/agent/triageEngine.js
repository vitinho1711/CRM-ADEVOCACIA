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
        ad_triggers: ['dr glaucio', 'anuncio', 'instagram', 'facebook', 'patrocinado', 'oi', 'ola', 'teste'],
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

function extractEmail(text) {
    const match = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/);
    return match ? match[1].toLowerCase() : null;
}

function cleanName(text) {
    let name = text.replace(/meu nome é/gi, '')
                   .replace(/me chamo/gi, '')
                   .replace(/sou o/gi, '')
                   .replace(/sou a/gi, '')
                   .replace(/ola/gi, '')
                   .replace(/olá/gi, '')
                   .trim();
    if (name.length > 50) name = name.substring(0, 50);
    return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function formatPhoneDisplay(phone) {
    if (!phone) return '';
    const p = String(phone).replace(/\D/g, '');
    if (p.length === 13 && p.startsWith('55')) {
        return `+55 (${p.substring(2,4)}) ${p.substring(4,9)}-${p.substring(9)}`;
    }
    if (p.length === 12 && p.startsWith('55')) {
        return `+55 (${p.substring(2,4)}) ${p.substring(4,8)}-${p.substring(8)}`;
    }
    if (p.length === 11) {
        return `(${p.substring(0,2)}) ${p.substring(2,7)}-${p.substring(7)}`;
    }
    if (p.length === 10) {
        return `(${p.substring(0,2)}) ${p.substring(2,6)}-${p.substring(6)}`;
    }
    return phone;
}

function getNextBusinessDayFormatted() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    if (d.getDay() === 6) d.setDate(d.getDate() + 2);

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

    async processIncoming(phone, messageText, instanceId = 'instance_1', remoteJid = null) {
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
        // REGRA DE OURO: IA RESPONDE EXCLUSIVAMENTE ANÚNCIOS / NOVOS LEADS
        // ========================================================
        if (client) {
            if (remoteJid && !client.remote_jid) {
                DatabaseService.saveOrUpdateClient(cleanPhone, { remote_jid: remoteJid });
            }
            if (client.from_ad === 0 || client.ai_active === 0) {
                console.log(`[BLOQUEIO IA] ${cleanPhone} é contato antigo ou humano. IA em silêncio.`);
                return null;
            }
        } else {
            // Se for pergunta sobre processo judicial antigo em andamento -> bloqueia!
            const isOldProcessInquiry = ['meu processo', 'andamento do processo', 'numero do processo', 'vara do trabalho', 'audiencia marcada'].some(k => normMsg.includes(k));
            if (isOldProcessInquiry) {
                console.log(`[BLOQUEIO IA] ${cleanPhone} perguntando de processo em andamento. IA em silêncio.`);
                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    instance_id: instanceId,
                    remote_jid: remoteJid,
                    from_ad: 0,
                    ai_active: 0,
                    status: 'NÃO QUALIFICADO',
                    source: 'cliente_antigo'
                });
                return null;
            }

            const isFromAd = isAdMessage(messageText);
            if (!isFromAd) {
                console.log(`[BLOQUEIO IA] Mensagem de ${cleanPhone} NÃO é de anúncio. IA não responde.`);
                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    instance_id: instanceId,
                    remote_jid: remoteJid,
                    from_ad: 0,
                    ai_active: 0,
                    status: 'NÃO QUALIFICADO',
                    source: 'organico_ou_pessoal'
                });
                return null;
            }

            console.log(`🎯 [NOVO LEAD DE ANÚNCIO DETECTADO] ${cleanPhone}`);
            const initialNiche = detectNicheFromText(messageText);

            // O TELEFONE JÁ É CAPTURADO AUTOMATICAMENTE NA ENTRADA!
            client = DatabaseService.saveOrUpdateClient(cleanPhone, {
                instance_id: instanceId,
                remote_jid: remoteJid,
                from_ad: 1,
                ai_active: 1,
                status: 'NOVO LEAD',
                source: 'anuncio',
                campaign: initialNiche || 'Campanha Geral',
                triage_step: 'collect_name'
            });

            Logger.log('LEAD_CREATED', { phone: cleanPhone, source: 'anuncio', instanceId });
        }

        DatabaseService.addMessage(cleanPhone, 'user', messageText);

        if (client.ai_active === 0) {
            return null;
        }

        const currentStepId = client.triage_step || 'collect_name';

        // ========================================================
        // ETAPA 0.1: COLETAR NOME COMPLETO DO LEAD
        // ========================================================
        if (currentStepId === 'collect_name') {
            if (!client.name) {
                const reply = `Olá! Seja muito bem-vindo(a) ao escritório Glaucio Dias Advocacia. 👋⚖️\n\nSou a assistente virtual e estou aqui para agilizar seu atendimento direto com o **Dr. Glaucio Dias**.\n\nPara iniciarmos seu cadastro formal com o advogado, por favor: **qual é o seu Nome Completo?**`;
                DatabaseService.saveOrUpdateClient(cleanPhone, { triage_step: 'waiting_name' });
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }
        }

        // ========================================================
        // ETAPA 0.2: NOME RECEBIDO -> AVANÇA DIRETO PARA O GMAIL
        // (NÃO pergunta o WhatsApp, pois a pessoa já está no WhatsApp!)
        // ========================================================
        if (currentStepId === 'waiting_name') {
            const leadName = cleanName(messageText);

            DatabaseService.saveOrUpdateClient(cleanPhone, {
                name: leadName,
                triage_step: 'waiting_email'
            });

            Logger.log('TRIAGE_ANSWER_SAVED', {
                phone: cleanPhone,
                step: 'collect_name',
                name: leadName
            });

            const reply = `Muito prazer em conhecê-lo(a), **${leadName}**! 🤝\n\nSeu contato de WhatsApp já foi registrado com sucesso em nosso sistema.\n\nAgora, para enviarmos a confirmação da reunião e documentos por e-mail, por favor: **qual é o seu E-mail (Gmail)?**`;
            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

        // ========================================================
        // ETAPA 0.3: COLETAR GMAIL DO LEAD ANTES DAS PERGUNTAS
        // ========================================================
        if (currentStepId === 'waiting_email') {
            let leadEmail = extractEmail(messageText);
            if (!leadEmail) {
                if (messageText.includes('@')) {
                    leadEmail = messageText.trim().toLowerCase();
                } else {
                    leadEmail = `${messageText.trim().replace(/\s+/g, '')}@gmail.com`.toLowerCase();
                }
            }

            DatabaseService.saveOrUpdateClient(cleanPhone, {
                email: leadEmail,
                triage_step: 'area_selection'
            });

            Logger.log('TRIAGE_ANSWER_SAVED', {
                phone: cleanPhone,
                step: 'collect_email',
                email: leadEmail
            });

            const preDetected = detectNicheFromText(client.campaign || '');
            if (preDetected && rules.niches[preDetected]) {
                const nicheConfig = rules.niches[preDetected];
                const firstStep = nicheConfig.steps[0];

                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    law_area: nicheConfig.name,
                    triage_step: firstStep ? firstStep.id : 'scheduling_format',
                    status: 'EM TRIAGEM'
                });

                const reply = `Perfeito, **${client.name || 'Cliente'}**! Seus dados de contato estão salvos:\n📱 Telefone: ${formatPhoneDisplay(cleanPhone)}\n📧 E-mail: ${leadEmail}\n\nIdentifiquei que sua solicitação é sobre **${nicheConfig.name}**. ⚖️\n\nPara analisarmos sua causa com máxima precisão:\n\n${firstStep.question}`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            const reply = `Perfeito, **${client.name || 'Cliente'}**! Cadastro inicial realizado com sucesso. ✅\n\nAgora, para direcionarmos sua situação para o advogado especialista:\n\n${rules.initial_step.question}`;
            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

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

                const reply = `Excelente! O Dr. Glaucio Dias e nossa equipe têm grande experiência em **${nicheConfig.name}**. ⚖️\n\nPara esclarecer seus direitos e preparar sua reunião:\n\n${firstStep ? firstStep.question : 'Poderia me contar brevemente o que aconteceu?'}`;
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
                summary: `Formato escolhido: ${chosenFormat}. Reunião com Dr. Glaucio Dias.`
            });

            let reply = '';
            if (chosenFormat === 'Presencial') {
                reply = `Perfeito, **${client.name || 'Cliente'}**! Será um prazer te receber pessoalmente em nosso escritório na **Av. Abílio Machado, 1380 - Alípio de Melo (Belo Horizonte / MG)**. 🏢\n\nDisponibilizamos horários de atendimento das **09:00 às 18:00** para **${nextDay.display}**:\n\n1️⃣ **09:30** (Manhã)\n2️⃣ **11:00** (Manhã)\n3️⃣ **14:00** (Tarde)\n4️⃣ **15:30** (Tarde)\n5️⃣ **17:00** (Fim de tarde)\n\nQual desses horários é melhor para você? (Ou pode me sugerir outro horário entre 09:00 e 18:00!)`;
            } else {
                reply = `Excelente, **${client.name || 'Cliente'}**! O atendimento **Online pelo Google Meet** é prático, seguro e sem trânsito. 📹\n\nDisponibilizamos horários de atendimento das **09:00 às 18:00** para **${nextDay.display}**:\n\n1️⃣ **09:30** (Manhã)\n2️⃣ **11:00** (Manhã)\n3️⃣ **14:00** (Tarde)\n4️⃣ **15:30** (Tarde)\n5️⃣ **17:00** (Fim de tarde)\n\nQual desses horários fica melhor para você? (Ou pode me sugerir qualquer outro horário entre 09:00 e 18:00!)`;
            }

            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

        // ========================================================
        // ETAPA DE FECHAMENTO 2: CONFIRMAÇÃO DO HORÁRIO E MEET REAL
        // ========================================================
        if (currentStepId === 'scheduling_slot') {
            const nextDay = getNextBusinessDayFormatted();
            let chosenTime = '14:00';

            if (['1', '09:30', '9:30', '9h30'].some(k => normMsg.includes(k))) chosenTime = '09:30';
            else if (['2', '11:00', '11h', '11'].some(k => normMsg.includes(k))) chosenTime = '11:00';
            else if (['3', '14:00', '14h', '14', 'duas'].some(k => normMsg.includes(k))) chosenTime = '14:00';
            else if (['4', '15:30', '15h30', '3h30'].some(k => normMsg.includes(k))) chosenTime = '15:30';
            else if (['5', '17:00', '17h', '17', 'cinco'].some(k => normMsg.includes(k))) chosenTime = '17:00';
            else {
                const timeMatch = messageText.match(/(\d{1,2})[:hH](\d{2})?/);
                if (timeMatch) {
                    let hour = parseInt(timeMatch[1], 10);
                    const min = timeMatch[2] || '00';
                    if (hour < 9) hour = 9;
                    if (hour > 18) hour = 17;
                    chosenTime = `${String(hour).padStart(2, '0')}:${min}`;
                }
            }

            const meetingType = client.summary?.includes('Presencial') ? 'Presencial' : 'Online (Google Meet)';
            const isOnline = meetingType.includes('Online');
            
            // UTILIZA A SALA OFICIAL PERMANENTE DO GOOGLE MEET
            const meetLink = isOnline ? DatabaseService.getOfficeMeetLink() : null;
            const displayPhone = formatPhoneDisplay(cleanPhone);

            const appointment = DatabaseService.createAppointment({
                phone: cleanPhone,
                name: client.name || 'Cliente',
                email: client.email || 'Não informado',
                date: nextDay.iso,
                time: chosenTime,
                meeting_type: meetingType,
                meet_link: meetLink,
                law_area: client.law_area || 'Direito Geral',
                summary: `Reunião agendada com Dr. Glaucio Dias. Lead: ${client.name || 'Cliente'} (${client.email || ''}). Caso: ${client.law_area || 'Área'}.`
            });

            DatabaseService.saveOrUpdateClient(cleanPhone, {
                triage_step: 'completed',
                status: 'AGENDADO'
            });

            Logger.log('CRM_SYNC_SUCCESS', {
                phone: cleanPhone,
                action: 'appointment_created',
                appointmentId: appointment.id,
                meetLink
            });

            let reply = '';
            if (isOnline) {
                reply = `🎉 **Reunião Online Agendada com Sucesso com o Dr. Glaucio Dias!**\n\n` +
                        `👤 **Cliente:** ${client.name || 'Cliente'}\n` +
                        `📧 **E-mail:** ${client.email || 'Cadastrado'}\n` +
                        `📱 **WhatsApp:** ${displayPhone}\n` +
                        `📅 **Data:** ${nextDay.display}\n` +
                        `🕒 **Horário:** ${chosenTime} (Atendimento oficial das 09:00 às 18:00)\n` +
                        `📹 **Formato:** Online pelo Google Meet\n` +
                        `🔗 **Link Oficial da Sala do Google Meet:**\n${meetLink}\n\n` +
                        `⚖️ **Advogado Responsável:** Dr. Glaucio Dias\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `📌 **FOLLOW-UP & ORIENTAÇÕES IMPORTANTES:**\n` +
                        `1. O horário foi reservado exclusivamente para você na agenda oficial do Dr. Glaucio;\n` +
                        `2. Deixe separados os documentos ou comprovantes do caso;\n` +
                        `3. No dia e horário marcados, basta clicar no link acima do Google Meet para entrar na sala;\n` +
                        `4. Enviaremos um lembrete no seu WhatsApp antes do início da reunião.\n\n` +
                        `Se tiver qualquer dúvida ou imprevisto, pode nos avisar por aqui a qualquer momento. Até breve!`;
            } else {
                reply = `🎉 **Reunião Presencial Agendada com Sucesso com o Dr. Glaucio Dias!**\n\n` +
                        `👤 **Cliente:** ${client.name || 'Cliente'}\n` +
                        `📧 **E-mail:** ${client.email || 'Cadastrado'}\n` +
                        `📱 **WhatsApp:** ${displayPhone}\n` +
                        `📅 **Data:** ${nextDay.display}\n` +
                        `🕒 **Horário:** ${chosenTime} (Atendimento oficial das 09:00 às 18:00)\n` +
                        `🏢 **Local:** Av. Abílio Machado, 1380 - Alípio de Melo, Belo Horizonte / MG\n` +
                        `🗺️ **Rota Google Maps:** https://maps.google.com/?q=Av.+Ab%C3%ADlio+Machado,+1380+-+Al%C3%ADpio+de+Melo\n` +
                        `⚖️ **Advogado Responsável:** Dr. Glaucio Dias\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `📌 **FOLLOW-UP & ORIENTAÇÕES IMPORTANTES:**\n` +
                        `1. Sua vaga está garantida na agenda do escritório;\n` +
                        `2. Traga seus documentos e anotações para análise conjunta com o Dr. Glaucio;\n` +
                        `3. Nosso escritório possui fácil estacionamento e recepção climatizada;\n` +
                        `4. Enviaremos uma mensagem de confirmação antes da reunião.\n\n` +
                        `Qualquer dúvida antes do atendimento, estamos à disposição por aqui. Te esperamos!`;
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
                const reply = nextStepObj.question;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            } else {
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

                const reply = `Entendido perfeitamente, **${client.name || 'Cliente'}**! Com base em tudo o que você me relatou, sua causa tem fundamentos jurídicos consistentes e prazos importantes a serem observados.\n\nO objetivo agora é esclarecer todas as dúvidas, fazer os cálculos e traçar a melhor estratégia diretamente em uma **reunião com o Dr. Glaucio Dias** ⚖️.\n\nNosso atendimento funciona das **09:00 às 18:00**. Como fica mais confortável para você?\n\n1️⃣ **Online (via Google Meet)** — Prático, seguro e sem trânsito\n2️⃣ **Presencial** — Em nosso escritório na Av. Abílio Machado, 1380 - Alípio de Melo (BH)`;

                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }
        }

        return null;
    }
};

module.exports = TriageEngine;
