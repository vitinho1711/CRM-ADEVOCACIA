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
    getClientByPhone(phone) {
        const db = readDb();
        return db.clients.find(c => c.phone === phone) || null;
    },

    saveOrUpdateClient(phone, data = {}) {
        if (!phone || phone === 'undefined') return null;
        const db = readDb();
        let client = db.clients.find(c => c.phone === phone);

        if (!client) {
            client = {
                id: Date.now(),
                phone: phone,
                name: data.name || null,
                city: data.city || null,
                law_area: data.law_area || null,
                summary: data.summary || null,
                urgency: data.urgency || 'A AVALIAR',
                documents: data.documents || null,
                client_goal: data.client_goal || null,
                status: data.status || 'TRIAGEM',
                from_ad: data.from_ad !== undefined ? (data.from_ad ? 1 : 0) : 1,
                ai_active: data.ai_active !== undefined ? (data.ai_active ? 1 : 0) : 1,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            db.clients.push(client);
        } else {
            for (const key of ['name', 'city', 'law_area', 'summary', 'urgency', 'documents', 'client_goal', 'status']) {
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

    setAiActive(phone, isActive) {
        const db = readDb();
        const client = db.clients.find(c => c.phone === phone);
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
        const db = readDb();
        db.messages.push({
            id: Date.now() + Math.random(),
            phone,
            role,
            content,
            created_at: new Date().toISOString()
        });
        writeDb(db);
    },

    getRecentMessages(phone, limit = 20) {
        const db = readDb();
        const clientMsgs = db.messages.filter(m => m.phone === phone);
        return clientMsgs.slice(-limit);
    },

    createAppointment({ phone, name, date, time, law_area, notes, summary, city, meeting_type }) {
        const db = readDb();
        const cleanPhone = (!phone || phone === 'undefined') ? (db.clients[0]?.phone || 'WhatsApp') : phone;
        const client = db.clients.find(c => c.phone === cleanPhone);

        // Define formato
        let finalMeetingType = 'Presencial';
        const checkText = `${meeting_type || ''} ${summary || ''} ${notes || ''}`.toLowerCase();
        if (checkText.includes('online') || checkText.includes('meet') || checkText.includes('video')) {
            finalMeetingType = 'Online (Google Meet)';
        }

        const appointment = {
            id: Date.now(),
            client_phone: cleanPhone,
            client_name: name || client?.name || 'Cliente',
            date: date,
            time: time,
            meeting_type: finalMeetingType,
            meet_link: finalMeetingType.includes('Online') ? 'https://meet.google.com/glaucio-advocacia' : null,
            maps_link: finalMeetingType.includes('Presencial') ? 'https://maps.google.com/?q=Av.+Ab%C3%ADlio+Machado,+1380+-+Al%C3%ADpio+de+Melo' : null,
            law_area: law_area || client?.law_area || 'Direito Geral',
            city: city || client?.city || 'Belo Horizonte / MG',
            summary: summary || notes || client?.summary || 'Pauta da reunião com o advogado',
            documents: client?.documents || 'Nenhum informado',
            notes: notes || '',
            status: 'CONFIRMADO',
            created_at: new Date().toISOString()
        };
        db.appointments.push(appointment);
        writeDb(db);

        this.saveOrUpdateClient(cleanPhone, { status: 'AGENDADO' });
        return appointment;
    },

    getAppointmentsForDate(date) {
        const db = readDb();
        return db.appointments.filter(a => a.date === date && a.status !== 'CANCELADO');
    },

    getAllAppointments() {
        const db = readDb();
        return db.appointments.map(a => {
            const client = db.clients.find(c => c.phone === a.client_phone) || db.clients[0];
            const checkText = `${a.meeting_type || ''} ${a.summary || ''} ${a.notes || ''}`.toLowerCase();
            const isOnline = checkText.includes('online') || checkText.includes('meet') || checkText.includes('video');
            const meetingType = isOnline ? 'Online (Google Meet)' : 'Presencial';

            let validPhone = a.client_phone;
            if (!validPhone || validPhone === 'undefined') {
                validPhone = client?.phone || 'WhatsApp';
            }

            return {
                ...a,
                client_phone: validPhone,
                client_name: a.client_name || client?.name || 'Cliente',
                city: a.city || client?.city || 'Belo Horizonte / MG',
                meeting_type: meetingType,
                meet_link: isOnline ? 'https://meet.google.com/glaucio-advocacia' : null,
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
        const db = readDb();
        db.clients = db.clients.filter(c => c.phone !== phone);
        db.messages = db.messages.filter(m => m.phone !== phone);
        db.appointments = db.appointments.filter(a => a.client_phone !== phone);
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
    }
};

module.exports = DatabaseService;
