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
        console.error('[TRIAGE ENGINE LOAD RULES ERROR]', e);
    }
    return {
        ad_triggers: [],
        initial_step: { question: 'Olá! Qual área você precisa?', options: [] },
        niches: {}
    };
}

function normalize(text) {
    if (!text) return '';
    return text.toString()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function isAdMessage(text) {
    if (!text) return false;
    const norm = normalize(text);
    const rules = loadRules();
    const triggers = rules.ad_triggers || [];
    if (triggers.some(trig => norm.includes(normalize(trig)))) {
        return true;
    }
    // Qualquer nova saudação ou contato de pelo menos 2 caracteres é acolhido
    return true;
}

function detectNicheFromText(text) {
    if (!text) return null;
    const norm = normalize(text);
    if (['trabalh', 'empreg', 'demiss', 'fgts', 'patrao', 'patrão', 'rescis'].some(k => norm.includes(k))) return 'Direito Trabalhista';
    if (['previd', 'inss', 'aposent', 'benefic', 'loas', 'bpc', 'auxilio'].some(k => norm.includes(k))) return 'Direito Previdenciário / INSS';
    if (['famili', 'divorc', 'guarda', 'penso', 'pensao', 'partilh', 'separac'].some(k => norm.includes(k))) return 'Direito de Família';
    if (['banc', 'golpe', 'pix', 'juros', 'emprest', 'financi', 'serasa', 'negativ'].some(k => norm.includes(k))) return 'Direito Bancário & Consumidor';
    return null;
}

function matchOption(options, text) {
    if (!options || !Array.isArray(options)) return null;
    const norm = normalize(text);

    for (const opt of options) {
        if (opt.aliases && Array.isArray(opt.aliases)) {
            for (const alias of opt.aliases) {
                const normAlias = normalize(alias);
                if (norm === normAlias) return opt;
                if (norm.startsWith(normAlias + ' ') || norm.endsWith(' ' + normAlias) || norm.includes(' ' + normAlias + ' ')) return opt;
            }
        }
        if (norm === normalize(opt.text)) return opt;
    }

    const firstWord = norm.split(' ')[0];
    for (const opt of options) {
        if (opt.aliases && opt.aliases.some(a => normalize(a) === firstWord)) {
            return opt;
        }
    }

    return null;
}

function formatPhoneDisplay(cleanPhone) {
    if (!cleanPhone) return '';
    let digits = cleanPhone.replace(/\D/g, '');
    if (digits.startsWith('55')) digits = digits.substring(2);
    if (digits.length === 11) {
        return `+55 (${digits.substring(0, 2)}) ${digits.substring(2, 7)}-${digits.substring(7)}`;
    }
    if (digits.length === 10) {
        return `+55 (${digits.substring(0, 2)}) ${digits.substring(2, 6)}-${digits.substring(6)}`;
    }
    return `+${cleanPhone}`;
}

function extractEmail(text) {
    if (!text) return null;
    const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    return match ? match[0].toLowerCase() : null;
}

function extractName(text) {
    if (!text) return null;
    const norm = normalize(text);
    
    // Se contém saudações ou palavras comuns de anúncio, NÃO é o nome do lead!
    const nonNameWords = ['ola', 'oi', 'bom dia', 'boa tarde', 'boa noite', 'anuncio', 'instagram', 'facebook', 'doutor', 'dr', 'advogado', 'ajuda', 'processo', 'informacao', 'quero', 'gostaria'];
    if (nonNameWords.some(w => norm.includes(w))) {
        // Apenas se tiver expressamente "meu nome é X"
        const explicitMatch = text.match(/(?:meu nome [eé]|me chamo|sou [oa])\s+([A-Za-zÀ-ÿ\s]{3,})/i);
        if (explicitMatch) {
            let name = explicitMatch[1].trim().replace(/[.,!?;:]/g, '');
            return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        }
        return null;
    }

    let cleaned = text.replace(/^(meu nome e|me chamo|sou o|sou a|o meu nome e|nome:|eu sou|chamo-me)\s+/i, '').trim();
    cleaned = cleaned.replace(/[.,!?;:]/g, '').trim();
    if (cleaned.length >= 3 && cleaned.length <= 40 && cleaned.includes(' ')) {
        return cleaned.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
    if (cleaned.length >= 3 && cleaned.length <= 25 && /^[A-Za-zÀ-ÿ]+$/.test(cleaned)) {
        return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    }
    return null;
}

function getNextBusinessDayFormatted() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 6) d.setDate(d.getDate() + 2);
    if (d.getDay() === 0) d.setDate(d.getDate() + 1);

    const dia = String(d.getDate()).padStart(2, '0');
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const ano = d.getFullYear();
    const diasSemana = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

    return {
        iso: `${ano}-${mes}-${dia}`,
        display: `${diasSemana[d.getDay()]}, ${dia}/${mes}/${ano}`
    };
}

function extractTimeFromMessage(text) {
    if (!text) return null;
    const norm = normalize(text);

    // Opções numéricas correspondentes aos botões sugeridos
    if (['1', 'opcao 1', 'opção 1'].some(k => norm === k)) return '09:30';
    if (['2', 'opcao 2', 'opção 2'].some(k => norm === k)) return '11:00';
    if (['3', 'opcao 3', 'opção 3'].some(k => norm === k)) return '13:00';
    if (['4', 'opcao 4', 'opção 4'].some(k => norm === k)) return '14:30';
    if (['5', 'opcao 5', 'opção 5'].some(k => norm === k)) return '16:00';
    if (['6', 'opcao 6', 'opção 6'].some(k => norm === k)) return '17:00';

    // Padrão de hora com minutos explícitos (ex: 13:00, 13:30, 09:30, 14h30, 15h)
    const matchHm = text.match(/(\d{1,2})\s*[:hH]\s*(\d{2})?/i);
    if (matchHm) {
        let hour = parseInt(matchHm[1], 10);
        let min = matchHm[2] ? parseInt(matchHm[2], 10) : 0;
        if (!isNaN(hour)) {
            if (hour >= 1 && hour <= 6 && (norm.includes('tarde') || norm.includes('pm'))) {
                hour += 12;
            }
            return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        }
    }

    // Padrão de hora por extenso ou isolada: "às 13", "somente as 13", "as 14 horas", "15 horas", "13"
    const matchHourOnly = text.match(/(?:as|às|ás|somente|apenas|prefer[oia]|posso|tenho|horario|horário)?\s*(\d{1,2})\s*(?:horas?|h\b)?/i);
    if (matchHourOnly) {
        let hour = parseInt(matchHourOnly[1], 10);
        if (!isNaN(hour) && hour >= 1 && hour <= 23) {
            if (hour >= 1 && hour <= 6 && (norm.includes('tarde') || norm.includes('pm'))) {
                hour += 12;
            }
            // Se for número entre 9 e 18, considera hora
            if (hour >= 9 && hour <= 18) {
                return `${String(hour).padStart(2, '0')}:00`;
            }
        }
    }

    return null;
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
            // Se foi marcado como NÃO QUALIFICADO automaticamente em teste anterior, reativa para acolher
            if (client.ai_active === 0 && client.status === 'NÃO QUALIFICADO') {
                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    ai_active: 1,
                    from_ad: 1,
                    status: 'NOVO LEAD'
                });
                client.ai_active = 1;
                client.from_ad = 1;
            }

            if (client.ai_active === 0) {
                console.log(`[BLOQUEIO IA] ${cleanPhone} está pausado manualmente pelo advogado. IA em silêncio.`);
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

            console.log(`🎯 [NOVO LEAD / CONTATO DETECTADO] ${cleanPhone}`);
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
        // ETAPA 0A: BOAS-VINDAS E CAPTURA DO NOME COMPLETO
        // ========================================================
        if (currentStepId === 'collect_name') {
            const detectedName = extractName(messageText);
            
            DatabaseService.saveOrUpdateClient(cleanPhone, {
                triage_step: 'waiting_name',
                remote_jid: remoteJid || client.remote_jid
            });

            if (detectedName && detectedName.includes(' ')) {
                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    name: detectedName,
                    triage_step: 'waiting_email'
                });

                Logger.log('TRIAGE_ANSWER_SAVED', { phone: cleanPhone, step: 'collect_name', name: detectedName });

                const reply = `Olá, **${detectedName}**! Seja muito bem-vindo(a) ao escritório Glaucio Dias Advocacia. 👋⚖️\n\nJá anotei seu nome para o **Dr. Glaucio Dias**.\n\nPara mantermos seu cadastro formal e enviarmos as orientações, por favor: **qual é o seu melhor e-mail (Gmail)?**`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            const reply = `Olá! Seja muito bem-vindo(a) ao escritório Glaucio Dias Advocacia. 👋⚖️\n\nEstou aqui para dar início ao seu atendimento e entender melhor a sua situação para o **Dr. Glaucio Dias**.\n\nPara começarmos: **qual é o seu Nome Completo?**`;
            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

        // ========================================================
        // ETAPA 0B: RECEBIMENTO DO NOME E SOLICITAÇÃO DO GMAIL
        // ========================================================
        if (currentStepId === 'waiting_name') {
            const candidateName = extractName(messageText) || messageText.trim();
            
            DatabaseService.saveOrUpdateClient(cleanPhone, {
                name: candidateName,
                triage_step: 'waiting_email'
            });

            Logger.log('TRIAGE_ANSWER_SAVED', { phone: cleanPhone, step: 'collect_name', name: candidateName });

            const reply = `Muito prazer, **${candidateName}**! 🤝\n\nPara podermos registrar seu caso e formalizar seu contato com o escritório, por favor: **qual é o seu melhor e-mail (Gmail)?**`;
            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

        // ========================================================
        // ETAPA 0C: RECEBIMENTO DO GMAIL E INÍCIO DA TRIAGEM DO CASO
        // ========================================================
        if (currentStepId === 'waiting_email') {
            const emailFound = extractEmail(messageText) || messageText.trim();
            
            DatabaseService.saveOrUpdateClient(cleanPhone, {
                email: emailFound,
                triage_step: 'area_selection'
            });

            Logger.log('TRIAGE_ANSWER_SAVED', { phone: cleanPhone, step: 'collect_email', email: emailFound });

            const reply = `Perfeito, **${client.name || 'Cliente'}**! Seu e-mail foi registrado com sucesso. 📧\n\nAgora vamos entender os detalhes do seu caso para que o **Dr. Glaucio Dias** já tenha todas as informações em mãos.\n\n${rules.initial_step.question}`;
            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

        // ========================================================
        // ETAPA 1: SELEÇÃO DA ÁREA / NICHO
        // ========================================================
        if (currentStepId === 'area_selection') {
            const matchedArea = matchOption(rules.initial_step.options, messageText);
            let chosenNicheKey = 'trabalhista';

            if (matchedArea) {
                chosenNicheKey = matchedArea.id;
            } else {
                const textNorm = normalize(messageText);
                if (textNorm.includes('trabalh') || textNorm.includes('empreg') || textNorm.includes('1')) chosenNicheKey = 'trabalhista';
                else if (textNorm.includes('inss') || textNorm.includes('previd') || textNorm.includes('2')) chosenNicheKey = 'previdenciario';
                else if (textNorm.includes('famil') || textNorm.includes('divorc') || textNorm.includes('3')) chosenNicheKey = 'familia';
                else if (textNorm.includes('banc') || textNorm.includes('golpe') || textNorm.includes('consum') || textNorm.includes('4')) chosenNicheKey = 'bancario_consumidor';
                else chosenNicheKey = 'outro';
            }

            const nicheConfig = rules.niches[chosenNicheKey] || rules.niches.trabalhista;
            const firstStep = nicheConfig.steps ? nicheConfig.steps[0] : null;

            DatabaseService.saveOrUpdateClient(cleanPhone, {
                law_area: nicheConfig.name,
                triage_step: firstStep ? firstStep.id : 'scheduling_format',
                qualification_status: 'EM TRIAGEM'
            });

            Logger.log('TRIAGE_STARTED', { phone: cleanPhone });
            Logger.log('TRIAGE_ANSWER_SAVED', { phone: cleanPhone, step: 'area_selection', area: nicheConfig.name });

            let reply = `Excelente! Vamos tratar da sua questão de **${nicheConfig.name}**.\n\n`;
            if (firstStep) {
                reply += firstStep.question;
            } else {
                reply += `Como podemos te ajudar hoje?`;
            }

            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
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
            const available = DatabaseService.getAvailableSlotsForDate(nextDay.iso);
            const slotsFormatted = available.map((s, idx) => `${idx + 1}️⃣ **${s}**`).join('\n');

            DatabaseService.saveOrUpdateClient(cleanPhone, {
                triage_step: 'scheduling_slot',
                summary: `Formato escolhido: ${chosenFormat}. Reunião com Dr. Glaucio Dias.`
            });

            let reply = '';
            if (chosenFormat === 'Presencial') {
                reply = `Perfeito, **${client.name || 'Cliente'}**! Será um prazer te receber pessoalmente em nosso escritório na **Av. Abílio Machado, 1380 - Alípio de Melo (Belo Horizonte / MG)**. 🏢\n\n` +
                        `Nosso horário de atendimento é de segunda a sexta, das **09:00 às 18:00**.\n\n` +
                        `Para **${nextDay.display}**, temos estes horários livres na agenda do Dr. Glaucio:\n\n` +
                        `${slotsFormatted}\n\n` +
                        `💡 *Qual desses horários fica melhor para você? Se preferir, pode me dizer o horário exato que tem disponibilidade (ex: "só posso às 13:00" ou "prefiro às 15h")!*`;
            } else {
                reply = `Excelente, **${client.name || 'Cliente'}**! O atendimento **Online pelo Google Meet** é prático, seguro e sem trânsito. 📹\n\n` +
                        `Nosso horário de atendimento é de segunda a sexta, das **09:00 às 18:00**.\n\n` +
                        `Para **${nextDay.display}**, temos estes horários livres na agenda do Dr. Glaucio:\n\n` +
                        `${slotsFormatted}\n\n` +
                        `💡 *Qual desses horários fica melhor para você? Se preferir, pode me dizer o horário exato que tem disponibilidade (ex: "só posso às 13:00" ou "prefiro às 15h")!*`;
            }

            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

        // ========================================================
        // ETAPA DE FECHAMENTO 2: CONFIRMAÇÃO DO HORÁRIO E MEET REAL
        // ========================================================
        if (currentStepId === 'scheduling_slot') {
            const nextDay = getNextBusinessDayFormatted();
            const extractedTime = extractTimeFromMessage(messageText);

            if (!extractedTime) {
                const available = DatabaseService.getAvailableSlotsForDate(nextDay.iso);
                const slotsFormatted = available.map((s, idx) => `${idx + 1}️⃣ **${s}**`).join('\n');

                const reply = `Por favor, **${client.name || 'Cliente'}**, informe qual horário fica melhor para você em **${nextDay.display}**.\n\nTemos disponíveis:\n\n${slotsFormatted}\n\n💡 *Você pode digitar o número da opção ou escrever seu próprio horário entre **09:00 e 18:00** (ex: "só posso às 13:00" ou "prefiro às 15h").*`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            const [hourStr, minStr] = extractedTime.split(':');
            const hour = parseInt(hourStr, 10);
            const min = parseInt(minStr, 10);

            // Validação 1: Expediente do escritório (09:00 às 18:00)
            if (hour < 9 || hour > 18 || (hour === 18 && min > 0)) {
                const available = DatabaseService.getAvailableSlotsForDate(nextDay.iso);
                const slotsFormatted = available.map((s, idx) => `${idx + 1}️⃣ **${s}**`).join('\n');

                const reply = `O horário das **${extractedTime}** fica fora do expediente de atendimento do Dr. Glaucio Dias (atendemos de segunda a sexta, das **09:00 às 18:00**).\n\nPara **${nextDay.display}**, temos os seguintes horários disponíveis:\n\n${slotsFormatted}\n\nAlgum desses horários fica bom para você, ou prefere sugerir outro horário entre 09:00 e 18:00?`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            // Validação 2: Disponibilidade na agenda
            const isAvailable = DatabaseService.isTimeSlotAvailable(nextDay.iso, extractedTime);
            if (!isAvailable) {
                const available = DatabaseService.getAvailableSlotsForDate(nextDay.iso);
                const slotsFormatted = available.length > 0
                    ? available.map((s, idx) => `${idx + 1}️⃣ **${s}**`).join('\n')
                    : 'Todos os horários principais deste dia já foram preenchidos.';

                const reply = `O horário das **${extractedTime}** em **${nextDay.display}** já está reservado na agenda do Dr. Glaucio.\n\nPara que você seja atendido(a) sem atrasos, temos livres neste mesmo dia:\n\n${slotsFormatted}\n\nQual desses horários é melhor para você, ou prefere marcar em outro dia?`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            // Horário disponível! Confirma agendamento
            const chosenTime = extractedTime;
            const meetingType = client.summary?.includes('Presencial') ? 'Presencial' : 'Online (Google Meet)';
            const isOnline = meetingType.includes('Online');
            
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
                        `1. O horário das ${chosenTime} foi reservado exclusivamente para você na agenda do Dr. Glaucio;\n` +
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
                        `1. Sua vaga das ${chosenTime} está garantida na agenda do escritório;\n` +
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

                const reply = `Entendido perfeitamente, **${client.name || 'Cliente'}**! Com base em tudo o que você me relatou, sua causa tem fundamentos jurídicos consistentes e prazos importantes a serem observados.\n\nO objetivo agora é esclarecer todas as dúvidas, fazer os cálculos e traçar a melhor estratégia diretamente em uma **reunião com o Dr. Glaucio Dias** ⚖️.\n\nNosso atendimento funciona de segunda a sexta, das **09:00 às 18:00**. Como fica mais confortável para você?\n\n1️⃣ **Online (via Google Meet)** — Prático, seguro e sem trânsito\n2️⃣ **Presencial** — Em nosso escritório na Av. Abílio Machado, 1380 - Alípio de Melo (BH)`;

                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }
        }

        // ========================================================
        // ETAPA 3: CLIENTE JÁ CONCLUIU A TRIAGEM / AGENDAMENTO (CONVERSA NATURAL)
        // ========================================================
        if (currentStepId === 'completed' || client.status === 'AGENDADO') {
            const allAppointments = DatabaseService.getAllAppointments() || [];
            const clientAppt = allAppointments.find(a => DatabaseService.normalizePhone(a.client_phone) === cleanPhone);

            const isReschedule = ['reagendar', 'mudar horario', 'mudar horário', 'outro horario', 'outro horário', 'trocar horario', 'trocar horário', 'remarcar', 'outro dia'].some(k => normMsg.includes(k));
            const isExplicitRestart = ['reiniciar do zero', 'recomecar do zero', 'apagar tudo e comecar'].some(k => normMsg.includes(k));

            if (isExplicitRestart) {
                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    triage_step: 'waiting_name',
                    triage_answers: [],
                    qualification_score: 0,
                    qualification_status: 'EM TRIAGEM',
                    status: 'NOVO LEAD'
                });
                const reply = `Com certeza! 🔄 Vamos reiniciar seu atendimento do zero para uma nova análise com o **Dr. Glaucio Dias**.\n\nPor favor: **qual é o seu Nome Completo?**`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            if (isReschedule) {
                DatabaseService.saveOrUpdateClient(cleanPhone, {
                    triage_step: 'scheduling_slot'
                });
                const nextDay = getNextBusinessDayFormatted();
                const available = DatabaseService.getAvailableSlotsForDate(nextDay.iso);
                const slotsFormatted = available.map((s, idx) => `${idx + 1}️⃣ **${s}**`).join('\n');

                const reply = `Com certeza, **${client.name || 'Cliente'}**! Podemos ajustar o seu horário de reunião com o Dr. Glaucio Dias para **${nextDay.display}**.\n\nHorários disponíveis na agenda:\n\n${slotsFormatted}\n\n💡 *Qual desses você prefere, ou gostaria de sugerir outro horário entre **09:00 e 18:00** (ex: "só posso às 13:00")?*`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            // Dúvidas sobre documentos a levar
            const isDocsInquiry = ['documento', 'documentos', 'levar', 'preciso levar', 'papel', 'separar', 'xerox'].some(k => normMsg.includes(k));
            if (isDocsInquiry) {
                const reply = `Olá, **${client.name || 'Cliente'}**! Para a sua reunião com o Dr. Glaucio Dias, recomendamos separar:\n\n` +
                              `📄 **Documentos Pessoais:** Documento com foto (RG ou CNH), CPF e comprovante de endereço recente;\n` +
                              `📋 **Comprovantes do Caso:** Holerites, carteira de trabalho, extratos bancários, contratos, laudos ou mensagens que comprovem a situação relatada;\n\n` +
                              `Não se preocupe se faltar algum item: o Dr. Glaucio analisará tudo com você detalhadamente na reunião!`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            // Dúvidas sobre endereço / localização
            const isAddressInquiry = ['endereco', 'endereço', 'local', 'onde fica', 'chegar', 'localizacao', 'localização', 'onibus', 'estacionamento', 'bairro'].some(k => normMsg.includes(k));
            if (isAddressInquiry) {
                const reply = `Nosso escritório fica no seguinte endereço:\n\n` +
                              `🏢 **Av. Abílio Machado, 1380 - Alípio de Melo, Belo Horizonte / MG**\n` +
                              `🗺️ **Localização no Google Maps:** https://maps.google.com/?q=Av.+Ab%C3%ADlio+Machado,+1380+-+Al%C3%ADpio+de+Melo\n\n` +
                              `Ponto de referência: Fácil acesso na Av. Abílio Machado, com recepção climatizada e comodidade para você!`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            // Dúvidas sobre link do Google Meet / como entrar
            const isMeetInquiry = ['meet', 'link', 'video', 'chamada', 'entrar', 'computador', 'celular', 'aplicativo', 'camera'].some(k => normMsg.includes(k));
            if (isMeetInquiry) {
                const meetLink = clientAppt?.meet_link || DatabaseService.getOfficeMeetLink();
                const reply = `Para a reunião online com o Dr. Glaucio Dias, basta acessar o link abaixo no horário combinado:\n\n` +
                              `🔗 **Link do Google Meet:** ${meetLink}\n\n` +
                              `💡 **Instruções:** Você pode entrar pelo celular ou computador. Recomendamos acessar uns 5 minutos antes para conferir seu áudio e câmera!`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            // Dúvidas sobre valores / honorários
            const isPriceInquiry = ['quanto custa', 'valor', 'preco', 'preço', 'cobra', 'honorarios', 'honorários', 'gratis', 'gratuito', 'taxa'].some(k => normMsg.includes(k));
            if (isPriceInquiry) {
                const reply = `Olá, **${client.name || 'Cliente'}**! O foco da reunião inicial com o Dr. Glaucio Dias é entender os detalhes do seu caso, analisar documentos, verificar seus direitos e traçar a melhor estratégia jurídica.\n\nCaso sejam necessárias medidas judiciais ou administrativas, todas as condições de honorários serão combinadas diretamente com você com total clareza e transparência.`;
                DatabaseService.addMessage(cleanPhone, 'assistant', reply);
                return reply;
            }

            // Conversação natural geral: acolhe e dialoga sem reiniciar!
            const apptInfo = clientAppt
                ? `Lembrando que sua reunião com o Dr. Glaucio está confirmada para **${clientAppt.date} às ${clientAppt.time}** (${clientAppt.meeting_type}).`
                : `Sua reunião com o Dr. Glaucio Dias já está registrada em nosso sistema.`;

            const reply = `Olá, **${client.name || 'Cliente'}**! Que bom falar com você. 👋⚖️\n\n` +
                          `Já deixei sua mensagem anotada na sua ficha de atendimento para o **Dr. Glaucio Dias**.\n\n` +
                          `${apptInfo}\n\n` +
                          `Se precisar de qualquer informação, orientações ou quiser ajustar algo antes do horário, estou à disposição por aqui!`;

            DatabaseService.addMessage(cleanPhone, 'assistant', reply);
            return reply;
        }

        return null;
    }
};

module.exports = TriageEngine;
