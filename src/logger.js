const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const logFile = path.join(dataDir, 'audit_logs.json');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

function readLogs() {
    try {
        if (!fs.existsSync(logFile)) {
            fs.writeFileSync(logFile, JSON.stringify([], null, 2), 'utf8');
            return [];
        }
        const content = fs.readFileSync(logFile, 'utf8');
        return JSON.parse(content) || [];
    } catch (e) {
        console.error('[LOGGER READ ERROR]', e);
        return [];
    }
}

function writeLogs(logs) {
    try {
        // Mantém os últimos 1000 logs para performance
        const trimmed = logs.slice(-1000);
        fs.writeFileSync(logFile, JSON.stringify(trimmed, null, 2), 'utf8');
    } catch (e) {
        console.error('[LOGGER WRITE ERROR]', e);
    }
}

const Logger = {
    log(eventType, data = {}) {
        const entry = {
            id: Date.now() + Math.random().toString(36).substring(2, 7),
            event: eventType,
            timestamp: new Date().toISOString(),
            ...data
        };

        console.log(`[AUDIT] [${entry.timestamp}] [${eventType}]`, JSON.stringify(data));

        const logs = readLogs();
        logs.push(entry);
        writeLogs(logs);

        return entry;
    },

    getRecentLogs(limit = 100) {
        const logs = readLogs();
        return logs.slice(-limit).reverse();
    },

    clearLogs() {
        writeLogs([]);
    }
};

module.exports = Logger;
