const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = path.join(__dirname, '..', 'data');
const backupsDir = path.join(dataDir, 'backups');
const sqliteFile = path.join(dataDir, 'crm_advocacia.sqlite');
const jsonBackupFile = path.join(dataDir, 'database.json');
const officeConfigFile = path.join(dataDir, 'office_config.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

function getOfficeMeetLink() {
    try {
        if (fs.existsSync(officeConfigFile)) {
            const raw = fs.readFileSync(officeConfigFile, 'utf8');
            const data = JSON.parse(raw);
            if (data.meet_link && data.meet_link.startsWith('http')) {
                return data.meet_link;
            }
        }
    } catch (e) {}
    return 'https://meet.google.com/bcj-ozww-txr';
}

function setOfficeMeetLink(link) {
    try {
        const finalLink = link && link.startsWith('http') ? link.trim() : 'https://meet.google.com/bcj-ozww-txr';
        fs.writeFileSync(officeConfigFile, JSON.stringify({ meet_link: finalLink }, null, 2), 'utf8');
        return true;
    } catch (e) {
        return false;
    }
}

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

// Inicia conexão SQLite com modo WAL (Write-Ahead Logging)
const sqlDb = new sqlite3.Database(sqliteFile, (err) => {
    if (err) {
        console.error('[SQLITE CONNECTION ERROR]', err);
    } else {
        console.log(`[SQLITE] Conectado com sucesso ao banco permanente: ${sqliteFile}`);
    }
});

sqlDb.serialize(() => {
    sqlDb.run("PRAGMA journal_mode = WAL;");
    sqlDb.run("PRAGMA synchronous = NORMAL;");

    sqlDb.run(`
        CREATE TABLE IF NOT EXISTS clients (
            id INTEGER PRIMARY KEY,
            phone TEXT UNIQUE NOT NULL,
            phone_raw TEXT,
            phone_contact TEXT,
            remote_jid TEXT,
            whatsapp TEXT,
            instance_id TEXT DEFAULT 'instance_1',
            name TEXT,
            email TEXT,
            city TEXT,
            law_area TEXT,
            source TEXT,
            campaign TEXT,
            adset TEXT,
            ad TEXT,
            creative TEXT,
            utm_source TEXT,
            utm_campaign TEXT,
            utm_medium TEXT,
            utm_content TEXT,
            status TEXT DEFAULT 'NOVO LEAD',
            triage_step TEXT DEFAULT 'collect_name',
            triage_answers TEXT,
            qualification_score INTEGER DEFAULT 0,
            qualification_status TEXT DEFAULT 'EM TRIAGEM',
            summary TEXT,
            urgency TEXT,
            documents TEXT,
            client_goal TEXT,
            notes TEXT,
            assigned_to TEXT DEFAULT 'Dr. Glaucio Dias',
            from_ad INTEGER DEFAULT 0,
            ai_active INTEGER DEFAULT 1,
            created_at TEXT,
            updated_at TEXT
        );
    `);

    sqlDb.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT
        );
    `);

    sqlDb.run(`
        CREATE TABLE IF NOT EXISTS appointments (
            id INTEGER PRIMARY KEY,
            client_phone TEXT NOT NULL,
            client_name TEXT,
            client_email TEXT,
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            meeting_type TEXT DEFAULT 'Presencial',
            meet_link TEXT,
            maps_link TEXT,
            law_area TEXT,
            city TEXT,
            summary TEXT,
            documents TEXT,
            notes TEXT,
            status TEXT DEFAULT 'CONFIRMADO',
            followup_count INTEGER DEFAULT 1,
            last_followup_at TEXT,
            created_at TEXT
        );
    `);

    sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);`);
    sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);`);
    sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_appointments_phone ON appointments(client_phone);`);
    sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);`);

    // Migração segura para colunas adicionais
    sqlDb.run("ALTER TABLE clients ADD COLUMN phone_contact TEXT;", () => {});
    sqlDb.run("ALTER TABLE clients ADD COLUMN remote_jid TEXT;", () => {});
    sqlDb.run("UPDATE clients SET ai_active = 1, from_ad = 1 WHERE status = 'NOVO LEAD' OR status = 'NÃO QUALIFICADO';", () => {});

    // Tabela permanente para salvar chaves de conexão do WhatsApp
    sqlDb.run(`
        CREATE TABLE IF NOT EXISTS baileys_sessions (
            id TEXT PRIMARY KEY,
            data TEXT,
            updated_at TEXT
        );
    `);
});

let memoryCache = {
    clients: [],
    messages: [],
    appointments: []
};

function loadInitialState() {
    try {
        sqlDb.all("SELECT * FROM clients", (err, rows) => {
            if (!err && rows && rows.length > 0) {
                memoryCache.clients = rows.map(r => ({
                    ...r,
                    triage_answers: r.triage_answers ? JSON.parse(r.triage_answers) : []
                }));
                console.log(`[SQLITE] ${rows.length} leads carregados do banco de dados SQLite.`);
            } else if (fs.existsSync(jsonBackupFile)) {
                try {
                    const raw = fs.readFileSync(jsonBackupFile, 'utf8');
                    const json = JSON.parse(raw);
                    if (json.clients && json.clients.length > 0) {
                        json.clients.forEach(c => persistClientToSqlite(c));
                        memoryCache.clients = json.clients;
                    }
                    if (json.appointments && json.appointments.length > 0) {
                        json.appointments.forEach(a => persistAppointmentToSqlite(a));
                        memoryCache.appointments = json.appointments;
                    }
                    if (json.messages && json.messages.length > 0) {
                        memoryCache.messages = json.messages;
                    }
                } catch (e) {
                    console.error('[MIGRATION ERROR]', e);
                }
            }
        });

        sqlDb.all("SELECT * FROM appointments", (err, rows) => {
            if (!err && rows && rows.length > 0) {
                memoryCache.appointments = rows;
            }
        });

        sqlDb.all("SELECT * FROM messages ORDER BY id DESC LIMIT 500", (err, rows) => {
            if (!err && rows && rows.length > 0) {
                memoryCache.messages = rows.reverse();
            }
        });
    } catch (e) {
        console.error('[LOAD INITIAL STATE ERROR]', e);
    }
}

loadInitialState();

function persistClientToSqlite(client) {
    const query = `
        INSERT OR REPLACE INTO clients (
            id, phone, phone_raw, phone_contact, remote_jid, whatsapp, instance_id, name, email, city, law_area,
            source, campaign, adset, ad, creative, utm_source, utm_campaign, utm_medium, utm_content,
            status, triage_step, triage_answers, qualification_score, qualification_status,
            summary, urgency, documents, client_goal, notes, assigned_to, from_ad, ai_active,
            created_at, updated_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?
        )
    `;

    const answersJson = Array.isArray(client.triage_answers) ? JSON.stringify(client.triage_answers) : (client.triage_answers || '[]');

    sqlDb.run(query, [
        client.id || Date.now(),
        client.phone,
        client.phone_raw || client.phone,
        client.phone_contact || null,
        client.remote_jid || null,
        client.whatsapp || `https://wa.me/${client.phone}`,
        client.instance_id || 'instance_1',
        client.name || null,
        client.email || null,
        client.city || null,
        client.law_area || null,
        client.source || null,
        client.campaign || null,
        client.adset || null,
        client.ad || null,
        client.creative || null,
        client.utm_source || null,
        client.utm_campaign || null,
        client.utm_medium || null,
        client.utm_content || null,
        client.status || 'NOVO LEAD',
        client.triage_step || 'collect_name',
        answersJson,
        client.qualification_score || 0,
        client.qualification_status || 'EM TRIAGEM',
        client.summary || null,
        client.urgency || null,
        client.documents || null,
        client.client_goal || null,
        client.notes || '',
        client.assigned_to || 'Dr. Glaucio Dias',
        client.from_ad ? 1 : 0,
        client.ai_active ? 1 : 0,
        client.created_at || new Date().toISOString(),
        client.updated_at || new Date().toISOString()
    ], (err) => {
        if (err) console.error('[SQLITE CLIENT INSERT ERROR]', err);
    });

    mirrorToJson();
}

function persistAppointmentToSqlite(appt) {
    const query = `
        INSERT OR REPLACE INTO appointments (
            id, client_phone, client_name, client_email, date, time, meeting_type,
            meet_link, maps_link, law_area, city, summary, documents, notes,
            status, followup_count, last_followup_at, created_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?
        )
    `;

    sqlDb.run(query, [
        appt.id || Date.now(),
        appt.client_phone,
        appt.client_name || 'Cliente',
        appt.client_email || 'Não informado',
        appt.date,
        appt.time,
        appt.meeting_type || 'Presencial',
        appt.meet_link || null,
        appt.maps_link || null,
        appt.law_area || 'Direito Geral',
        appt.city || 'Belo Horizonte / MG',
        appt.summary || 'Reunião',
        appt.documents || 'Nenhum',
        appt.notes || '',
        appt.status || 'CONFIRMADO',
        appt.followup_count || 1,
        appt.last_followup_at || new Date().toISOString(),
        appt.created_at || new Date().toISOString()
    ], (err) => {
        if (err) console.error('[SQLITE APPOINTMENT INSERT ERROR]', err);
    });

    mirrorToJson();
}

function persistMessageToSqlite(msg) {
    sqlDb.run(
        "INSERT INTO messages (phone, role, content, created_at) VALUES (?, ?, ?, ?)",
        [msg.phone, msg.role, msg.content, msg.created_at || new Date().toISOString()],
        (err) => {
            if (err) console.error('[SQLITE MESSAGE INSERT ERROR]', err);
        }
    );
    mirrorToJson();
}

let mirrorDebounce = null;
function mirrorToJson() {
    clearTimeout(mirrorDebounce);
    mirrorDebounce = setTimeout(() => {
        try {
            fs.writeFileSync(jsonBackupFile, JSON.stringify(memoryCache, null, 2), 'utf8');
        } catch (e) {
            console.error('[MIRROR JSON ERROR]', e);
        }
    }, 500);
}

const DatabaseService = {
    normalizePhone,
    getOfficeMeetLink,
    setOfficeMeetLink,
    sqliteFile,

    createDatabaseBackup() {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = path.join(backupsDir, `crm_backup_${timestamp}.sqlite`);
            fs.copyFileSync(sqliteFile, backupPath);
            return { success: true, backupPath, filename: path.basename(backupPath) };
        } catch (e) {
            console.error('[BACKUP ERROR]', e);
            return { success: false, error: e.message };
        }
    },

    getClientByPhone(phone) {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return null;
        return memoryCache.clients.find(c => normalizePhone(c.phone) === cleanPhone || (c.phone_contact && normalizePhone(c.phone_contact) === cleanPhone)) || null;
    },

    saveOrUpdateClient(phone, data = {}) {
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return null;

        let client = memoryCache.clients.find(c => normalizePhone(c.phone) === cleanPhone || (c.phone_contact && normalizePhone(c.phone_contact) === cleanPhone));

        if (!client) {
            client = {
                id: Date.now(),
                phone: cleanPhone,
                phone_raw: String(phone),
                phone_contact: data.phone_contact || null,
                remote_jid: data.remote_jid || null,
                whatsapp: `https://wa.me/${cleanPhone}`,
                instance_id: data.instance_id || 'instance_1',
                name: data.name || null,
                email: data.email || null,
                city: data.city || null,
                law_area: data.law_area || null,
                source: data.source || 'anuncio',
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
                from_ad: data.from_ad !== undefined ? (data.from_ad ? 1 : 0) : 1,
                ai_active: data.ai_active !== undefined ? (data.ai_active ? 1 : 0) : 1,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            memoryCache.clients.push(client);
        } else {
            const updatableKeys = [
                'name', 'email', 'phone_contact', 'remote_jid', 'city', 'law_area', 'source', 'campaign', 'adset', 'ad', 'creative',
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

        persistClientToSqlite(client);
        return client;
    },

    saveTriageAnswer(phone, step, question, answer, points = 0, nextStep = null) {
        const cleanPhone = normalizePhone(phone);
        const client = memoryCache.clients.find(c => normalizePhone(c.phone) === cleanPhone || (c.phone_contact && normalizePhone(c.phone_contact) === cleanPhone));
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
        persistClientToSqlite(client);
        return client;
    },

    setAiActive(phone, isActive) {
        const cleanPhone = normalizePhone(phone);
        const client = memoryCache.clients.find(c => normalizePhone(c.phone) === cleanPhone);
        if (client) {
            client.ai_active = isActive ? 1 : 0;
            client.updated_at = new Date().toISOString();
            persistClientToSqlite(client);
        }
    },

    getAllClients() {
        return memoryCache.clients.filter(c => c.phone && c.phone !== 'undefined')
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    },

    addMessage(phone, role, content) {
        const cleanPhone = normalizePhone(phone);
        const msg = {
            id: Date.now() + Math.random(),
            phone: cleanPhone,
            role,
            content,
            created_at: new Date().toISOString()
        };
        memoryCache.messages.push(msg);
        persistMessageToSqlite(msg);
    },

    getRecentMessages(phone, limit = 30) {
        const cleanPhone = normalizePhone(phone);
        const clientMsgs = memoryCache.messages.filter(m => normalizePhone(m.phone) === cleanPhone);
        return clientMsgs.slice(-limit);
    },

    createAppointment({ phone, name, email, date, time, law_area, notes, summary, city, meeting_type, meet_link }) {
        const cleanPhone = normalizePhone(phone) || (memoryCache.clients[0]?.phone || 'WhatsApp');
        const client = memoryCache.clients.find(c => normalizePhone(c.phone) === cleanPhone || (c.phone_contact && normalizePhone(c.phone_contact) === cleanPhone));

        let finalMeetingType = 'Presencial';
        const checkText = `${meeting_type || ''} ${summary || ''} ${notes || ''}`.toLowerCase();
        if (checkText.includes('online') || checkText.includes('meet') || checkText.includes('video')) {
            finalMeetingType = 'Online (Google Meet)';
        }

        const isOnline = finalMeetingType.includes('Online');
        const finalMeetLink = isOnline ? (meet_link || getOfficeMeetLink()) : null;

        const appointment = {
            id: Date.now(),
            client_phone: client?.phone_contact || cleanPhone,
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
        memoryCache.appointments.push(appointment);
        persistAppointmentToSqlite(appointment);

        this.saveOrUpdateClient(cleanPhone, { 
            name: appointment.client_name,
            email: appointment.client_email,
            status: 'AGENDADO' 
        });
        return appointment;
    },

    registerFollowUpSent(appointmentId) {
        const appt = memoryCache.appointments.find(a => a.id == appointmentId);
        if (appt) {
            appt.followup_count = (appt.followup_count || 0) + 1;
            appt.last_followup_at = new Date().toISOString();
            persistAppointmentToSqlite(appt);
            return appt;
        }
        return null;
    },

    getAppointmentsForDate(date) {
        return memoryCache.appointments.filter(a => a.date === date && a.status !== 'CANCELADO');
    },

    isTimeSlotAvailable(date, time) {
        if (!date || !time) return false;
        const cleanTime = String(time).trim();
        const booked = (memoryCache.appointments || []).find(a => 
            a.date === date && 
            (a.time === cleanTime || a.time?.startsWith(cleanTime.substring(0, 4))) && 
            a.status !== 'CANCELADO'
        );
        return !booked;
    },

    getAvailableSlotsForDate(date) {
        const allStandardSlots = ['09:30', '10:30', '11:30', '13:00', '14:00', '15:00', '16:00', '17:00'];
        const booked = (memoryCache.appointments || [])
            .filter(a => a.date === date && a.status !== 'CANCELADO')
            .map(a => a.time);
        
        return allStandardSlots.filter(slot => !booked.some(b => b === slot || b?.startsWith(slot.substring(0, 4))));
    },

    getAllAppointments() {
        return memoryCache.appointments.map(a => {
            const cleanPhone = normalizePhone(a.client_phone);
            const client = memoryCache.clients.find(c => normalizePhone(c.phone) === cleanPhone || (c.phone_contact && normalizePhone(c.phone_contact) === cleanPhone)) || memoryCache.clients[0];
            const checkText = `${a.meeting_type || ''} ${a.summary || ''} ${a.notes || ''}`.toLowerCase();
            const isOnline = checkText.includes('online') || checkText.includes('meet') || checkText.includes('video');
            const meetingType = isOnline ? 'Online (Google Meet)' : 'Presencial';

            return {
                ...a,
                client_phone: client?.phone_contact || cleanPhone || client?.phone || 'WhatsApp',
                client_name: a.client_name || client?.name || 'Cliente',
                client_email: a.client_email || client?.email || 'Não informado',
                city: a.city || client?.city || 'Belo Horizonte / MG',
                meeting_type: meetingType,
                meet_link: a.meet_link || (isOnline ? getOfficeMeetLink() : null),
                maps_link: !isOnline ? 'https://maps.google.com/?q=Av.+Ab%C3%ADlio+Machado,+1380+-+Al%C3%ADpio+de+Melo' : null,
                summary: a.summary || client?.summary || a.notes || 'Pauta da reunião com o advogado',
                documents: a.documents || client?.documents || 'Nenhum'
            };
        }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    },

    cancelAppointment(id) {
        const appt = memoryCache.appointments.find(a => a.id == id);
        if (appt) {
            appt.status = 'CANCELADO';
            persistAppointmentToSqlite(appt);
            return true;
        }
        return false;
    },

    deleteClient(phone) {
        const cleanPhone = normalizePhone(phone);
        memoryCache.clients = memoryCache.clients.filter(c => normalizePhone(c.phone) !== cleanPhone && (!c.phone_contact || normalizePhone(c.phone_contact) !== cleanPhone));
        memoryCache.messages = memoryCache.messages.filter(m => normalizePhone(m.phone) !== cleanPhone);
        memoryCache.appointments = memoryCache.appointments.filter(a => normalizePhone(a.client_phone) !== cleanPhone);

        sqlDb.run("DELETE FROM clients WHERE phone = ? OR phone_contact = ?", [cleanPhone, cleanPhone]);
        sqlDb.run("DELETE FROM messages WHERE phone = ?", [cleanPhone]);
        sqlDb.run("DELETE FROM appointments WHERE client_phone = ?", [cleanPhone]);

        mirrorToJson();
        return true;
    },

    clearAllClients() {
        memoryCache.clients = [];
        memoryCache.messages = [];
        memoryCache.appointments = [];

        sqlDb.run("DELETE FROM clients;");
        sqlDb.run("DELETE FROM messages;");
        sqlDb.run("DELETE FROM appointments;");

        mirrorToJson();
        return true;
    },

    getLeadMetrics() {
        const clients = memoryCache.clients || [];
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
    },

    saveSessionFile(instanceId, fileName, content) {
        const key = `${instanceId}:${fileName}`;
        sqlDb.run(
            "INSERT OR REPLACE INTO baileys_sessions (id, data, updated_at) VALUES (?, ?, ?)",
            [key, content, new Date().toISOString()]
        );
    },

    restoreSessionFiles(instanceId, targetDir) {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        return new Promise((resolve) => {
            sqlDb.all("SELECT id, data FROM baileys_sessions WHERE id LIKE ?", [`${instanceId}:%`], (err, rows) => {
                if (!err && rows && rows.length > 0) {
                    console.log(`[SQLITE SESSIONS] Restaurando ${rows.length} arquivos de sessão permanente para ${instanceId}...`);
                    for (const row of rows) {
                        const fileName = row.id.replace(`${instanceId}:`, '');
                        const filePath = path.join(targetDir, fileName);
                        try {
                            fs.writeFileSync(filePath, row.data, 'utf8');
                        } catch(e) {}
                    }
                }
                resolve();
            });
        });
    },

    clearSessionFiles(instanceId) {
        sqlDb.run("DELETE FROM baileys_sessions WHERE id LIKE ?", [`${instanceId}:%`]);
    }
};

module.exports = DatabaseService;
