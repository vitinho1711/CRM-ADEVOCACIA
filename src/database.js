const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'database.json');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const defaultData = {
    clients: [],
    messages: [],
    appointments: []
};

// Normalizador seguro de números de telefone brasileiros
function normalizePhone(rawPhone) {
    if (!rawPhone) return '';
    let digits = String(rawPhone).replace(/\D/g, '');
    
    if (digits.length > 15) {
        digits = digits.substring(0, 13);
    }

    if (digits.startsWith('0')) {
        digits = digits.substring(1);
    }

    if (digits.length === 10 || digits.length === 11) {
        digits = '55' + digits;
    }

    if (digits.length === 12 && digits.startsWith('55')) {
        const ddd = digits.substring(2, 4);
        const rest = digits.substring(4);
        if (['6', '7', '8', '9'].includes(rest[0])) {
            digits = `55${ddd}9${rest}`;
        }
    }

    return digits;
}

function generateGoogleMeetLink() {
    const chars = 'abcdefghijklmnopqrstuvwxyz';
    const rand = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `https://meet.google.com/${rand(3)}-${rand(4)}-${rand(3)}`;
}

function readDb() {
    try {
        if (!fs.existsSync(dbFile)) {
            fs.writeFileSync(dbFile, JSON.stringify(defaultData, null, 2), 'utf8');
            return defaultData;
        }
        const raw = fs.readFileSync(dbFile, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.error('[DB READ ERROR]', e);
        return defaultData;
    }
}

function writeDb(data) {
    try {
        fs.writeFileSync(dbFile, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error('[DB WRITE ERROR]', e);
    }
}

const DatabaseService = {
    normalizePhone,
    generateGoogleMeetLink,

    getClientByPhone(phone) {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return null;
        const db = readDb();
        return db.clients.find(c => normalizePhone(c.phone) === cleanPhone) || null;
    },

    saveOrUpdateClient(phone, data = {}) {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return null;

        const db = readDb();
        let client = db.clients.find(c => normalizePhone(c.phone) === cleanPhone);

        if (!client) {
            client = {
                id: Date.now(),
                phone: cleanPhone,
                phone_raw: String(phone),
                whatsapp: `https://wa.me/${cleanPhone}`,
                instance_id: data.instance_id || 'instance_1',
                name: data.name || null,
                email: data.email || null,
                city: data.city || null,
                law_area: data.law_area || null,
                source: data.source || (data.from_ad ? 'anuncio' : 'organico'),
                campaign: data.campaign || null,
                adset: data.adset || null,
                ad: data.ad || null,
                creative: data.creative || null,
                utm_source: data.utm_source || null,
                utm_campaign: data.utm_campaign || null,
                utm_medium: data.utm_medium || null,
                utm_content: data.utm_content || null,
                status: data.status || 'NOVO LEAD',
                triage_step: data.triage_step || 'collect_name',
                triage_answers: Array.isArray(data.triage_answers) ? data.triage_answers : [],
                qualification_score: data.qualification_score !== undefined ? Number(data.qualification_score) : 0,
                qualification_status: data.qualification_status || 'EM TRIAGEM',
                summary: data.summary || null,
                urgency: data.urgency || 'A AVALIAR',
                documents: data.documents || null,
                client_goal: data.client_goal || null,
                notes: data.notes || '',
                assigned_to: data.assigned_to || 'Dr. Glaucio Dias',
                from_ad: data.from_ad !== undefined ? (data.from_ad ? 1 : 0) : 0,
                ai_active: data.ai_active !== undefined ? (data.ai_active ? 1 : 0) : 1,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            db.clients.push(client);
        } else {
            const updatableKeys = [
                'name', 'email', 'city', 'law_area', 'source', 'campaign', 'adset', 'ad', 'creative',
                'utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'status',
                'triage_step', 'triage_answers', 'qualification_score', 'qualification_status',
                'summary', 'urgency', 'documents', 'client_goal', 'notes', 'assigned_to',
                'instance_id'
            ];

            for (const key of updatableKeys) {
                if (data[key] !== undefined && data[key] !== null) {
                    client[key] = data[key];
                }
            }

            if (data.from_ad !== undefined) {
                client.from_ad = data.from_ad ? 1 : 0;
            }
            if (data.ai_active !== undefined) {
                client.ai_active = data.ai_active ? 1 : 0;
            }

            client.updated_at = new Date().toISOString();
        }

        writeDb(db);
        return client;
    },

    saveTriageAnswer(phone, step, question, answer, points = 0, nextStep = null) {
        const cleanPhone = normalizePhone(phone);
        const db = readDb();
        const client = db.clients.find(c => normalizePhone(c.phone) === cleanPhone);
        if (!client) return null;

        if (!Array.isArray(client.triage_answers)) {
            client.triage_answers = [];
        }

        const existingIdx = client.triage_answers.findIndex(a => a.step === step);
        const answerObj = {
            step,
            question,
            answer,
            points: Number(points) || 0,
            answered_at: new Date().toISOString()
        };

        if (existingIdx >= 0) {
            client.triage_answers[existingIdx] = answerObj;
        } else {
            client.triage_answers.push(answerObj);
        }

        const totalScore = Math.min(100, client.triage_answers.reduce((acc, curr) => acc + (curr.points || 0), 0));
        client.qualification_score = totalScore;

        if (totalScore >= 81) {
            client.qualification_status = 'ALTA PRIORIDADE';
        } else if (totalScore >= 61) {
            client.qualification_status = 'QUALIFICADO';
        } else if (totalScore >= 31) {
            client.qualification_status = 'EM ANÁLISE';
        } else {
            client.qualification_status = 'BAIXA PRIORIDADE';
        }

        if (nextStep) {
            client.triage_step = nextStep;
            if (nextStep === 'completed') {
                client.status = totalScore >= 61 ? 'QUALIFICADO' : 'EM TRIAGEM';
            } else {
                client.status = 'EM TRIAGEM';
            }
        }

        client.updated_at = new Date().toISOString();
        writeDb(db);
        return client;
    },

    setAiActive(phone, isActive) {
        const cleanPhone = normalizePhone(phone);
        const db = readDb();
        const client = db.clients.find(c => normalizePhone(c.phone) === cleanPhone);
        if (client) {
            client.ai_active = isActive ? 1 : 0;
            client.updated_at = new Date().toISOString();
            writeDb(db);
        }
    },

    getAllClients() {
        const db = readDb();
        return db.clients.filter(c => c.phone && c.phone !== 'undefined')
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    },

    addMessage(phone, role, content) {
        const cleanPhone = normalizePhone(phone);
        const db = readDb();
        db.messages.push({
            id: Date.now() + Math.random(),
            phone: cleanPhone,
            role,
            content,
            created_at: new Date().toISOString()
        });
        writeDb(db);
    },

    getRecentMessages(phone, limit = 30) {
        const cleanPhone = normalizePhone(phone);
        const db = readDb();
        const clientMsgs = db.messages.filter(m => normalizePhone(m.phone) === cleanPhone);
        return clientMsgs.slice(-limit);
    },

    createAppointment({ phone, name, email, date, time, law_area, notes, summary, city, meeting_type, meet_link }) {
        const db = readDb();
        const cleanPhone = normalizePhone(phone) || (db.clients[0]?.phone || 'WhatsApp');
        const client = db.clients.find(c => normalizePhone(c.phone) === cleanPhone);

        let finalMeetingType = 'Presencial';
        const checkText = `${meeting_type || ''} ${summary || ''} ${notes || ''}`.toLowerCase();
        if (checkText.includes('online') || checkText.includes('meet') || checkText.includes('video')) {
            finalMeetingType = 'Online (Google Meet)';
        }

        const isOnline = finalMeetingType.includes('Online');
        const finalMeetLink = isOnline ? (meet_link || generateGoogleMeetLink()) : null;

        const appointment = {
            id: Date.now(),
            client_phone: cleanPhone,
            client_name: name || client?.name || 'Cliente',
            client_email: email || client?.email || 'Não informado',
            date: date,
            time: time,
            meeting_type: finalMeetingType,
            meet_link: finalMeetLink,
            maps_link: !isOnline ? 'https://maps.google.com/?q=Av.+Ab%C3%ADlio+Machado,+1380+-+Al%C3%ADpio+de+Melo' : null,
            law_area: law_area || client?.law_area || 'Direito Geral',
            city: city || client?.city || 'Belo Horizonte / MG',
            summary: summary || notes || client?.summary || 'Pauta da reunião com o advogado',
            documents: client?.documents || 'Nenhum informado',
            notes: notes || '',
            status: 'CONFIRMADO',
            followup_count: 1,
            last_followup_at: new Date().toISOString(),
            created_at: new Date().toISOString()
        };
        db.appointments.push(appointment);
        writeDb(db);

        this.saveOrUpdateClient(cleanPhone, { 
            name: appointment.client_name,
            email: appointment.client_email,
            status: 'AGENDADO' 
        });
        return appointment;
    },

    registerFollowUpSent(appointmentId) {
        const db = readDb();
        const appt = db.appointments.find(a => a.id == appointmentId);
        if (appt) {
            appt.followup_count = (appt.followup_count || 0) + 1;
            appt.last_followup_at = new Date().toISOString();
            writeDb(db);
            return appt;
        }
        return null;
    },

    getAppointmentsForDate(date) {
        const db = readDb();
        return db.appointments.filter(a => a.date === date && a.status !== 'CANCELADO');
    },

    getAllAppointments() {
        const db = readDb();
        return db.appointments.map(a => {
            const cleanPhone = normalizePhone(a.client_phone);
            const client = db.clients.find(c => normalizePhone(c.phone) === cleanPhone) || db.clients[0];
            const checkText = `${a.meeting_type || ''} ${a.summary || ''} ${a.notes || ''}`.toLowerCase();
            const isOnline = checkText.includes('online') || checkText.includes('meet') || checkText.includes('video');
            const meetingType = isOnline ? 'Online (Google Meet)' : 'Presencial';

            return {
                ...a,
                client_phone: cleanPhone || client?.phone || 'WhatsApp',
                client_name: a.client_name || client?.name || 'Cliente',
                client_email: a.client_email || client?.email || 'Não informado',
                city: a.city || client?.city || 'Belo Horizonte / MG',
                meeting_type: meetingType,
                meet_link: a.meet_link || (isOnline ? 'https://meet.google.com/glaucio-advocacia' : null),
                maps_link: !isOnline ? 'https://maps.google.com/?q=Av.+Ab%C3%ADlio+Machado,+1380+-+Al%C3%ADpio+de+Melo' : null,
                summary: a.summary || client?.summary || a.notes || 'Pauta da reunião com o advogado',
                documents: a.documents || client?.documents || 'Nenhum'
            };
        }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    cancelAppointment(id) {
        const db = readDb();
        const appt = db.appointments.find(a => a.id == id);
        if (appt) {
            appt.status = 'CANCELADO';
            writeDb(db);
            return true;
        }
        return false;
    },

    deleteClient(phone) {
        const cleanPhone = normalizePhone(phone);
        const db = readDb();
        db.clients = db.clients.filter(c => normalizePhone(c.phone) !== cleanPhone);
        db.messages = db.messages.filter(m => normalizePhone(m.phone) !== cleanPhone);
        db.appointments = db.appointments.filter(a => normalizePhone(a.client_phone) !== cleanPhone);
        writeDb(db);
        return true;
    },

    clearAllClients() {
        const db = readDb();
        db.clients = [];
        db.messages = [];
        db.appointments = [];
        writeDb(db);
        return true;
    },

    getLeadMetrics() {
        const db = readDb();
        const clients = db.clients || [];
        const totalLeads = clients.length;

        const emTriagem = clients.filter(c => c.status === 'EM TRIAGEM' || c.status === 'NOVO LEAD').length;
        const triagensConcluidas = clients.filter(c => c.triage_step === 'completed' || ['QUALIFICADO', 'ALTA PRIORIDADE', 'AGENDADO'].includes(c.status)).length;
        const triagensIncompletas = clients.filter(c => c.status === 'TRIAGEM INCOMPLETA' || (c.triage_answers?.length > 0 && c.triage_step !== 'completed')).length;

        const qualificados = clients.filter(c => c.qualification_status === 'QUALIFICADO' || c.qualification_status === 'ALTA PRIORIDADE' || c.status === 'QUALIFICADO').length;
        const altaPrioridade = clients.filter(c => c.qualification_status === 'ALTA PRIORIDADE').length;
        const naoQualificados = clients.filter(c => c.qualification_status === 'BAIXA PRIORIDADE' || c.qualification_status === 'NÃO QUALIFICADO' || c.status === 'NÃO QUALIFICADO').length;

        const taxaQualificacao = totalLeads > 0 ? Math.round((qualificados / totalLeads) * 100) : 0;

        const porArea = {
            trabalhista: clients.filter(c => (c.law_area || '').toLowerCase().includes('trabalh')).length,
            previdenciario: clients.filter(c => (c.law_area || '').toLowerCase().includes('previd')).length,
            familia: clients.filter(c => (c.law_area || '').toLowerCase().includes('fam')).length,
            bancario_consumidor: clients.filter(c => (c.law_area || '').toLowerCase().includes('banc') || (c.law_area || '').toLowerCase().includes('consum')).length,
            outros: clients.filter(c => {
                const a = (c.law_area || '').toLowerCase();
                return a && !a.includes('trabalh') && !a.includes('previd') && !a.includes('fam') && !a.includes('banc') && !a.includes('consum');
            }).length
        };

        const campanhasMap = {};
        clients.forEach(c => {
            const camp = c.campaign || c.source || 'Não Identificada';
            if (!campanhasMap[camp]) {
                campanhasMap[camp] = { total: 0, qualificados: 0 };
            }
            campanhasMap[camp].total++;
            if (c.qualification_status === 'QUALIFICADO' || c.qualification_status === 'ALTA PRIORIDADE') {
                campanhasMap[camp].qualificados++;
            }
        });

        return {
            totalLeads,
            emTriagem,
            triagensConcluidas,
            triagensIncompletas,
            qualificados,
            altaPrioridade,
            naoQualificados,
            taxaQualificacao,
            porArea,
            campanhas: campanhasMap
        };
    }
};

module.exports = DatabaseService;
