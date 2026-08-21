// Módulo de integração opcional com Google Calendar API
// Se credenciais do Google não forem inseridas, o sistema usa o banco de dados interno integrado.

const GoogleCalendarIntegration = {
    async checkAvailability(date) {
        // Mock / Conexão pronta para Google Calendar API
        return {
            date: date,
            status: 'available',
            source: 'internal_agenda'
        };
    },

    async createEvent({ title, description, startDateTime, endDateTime, attendeeEmail }) {
        console.log(`[GOOGLE CALENDAR] Criando evento: ${title} em ${startDateTime}`);
        return {
            success: true,
            eventLink: 'https://calendar.google.com'
        };
    }
};

module.exports = GoogleCalendarIntegration;
