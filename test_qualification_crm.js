const assert = require('assert');
const path = require('path');
const DatabaseService = require('./src/database');
const TriageEngine = require('./src/agent/triageEngine');
const { getAllWhatsAppStatus, getWhatsAppStatus } = require('./src/integrations/whatsappDirect');
const Logger = require('./src/logger');

async function runTests() {
    console.log('====================================================');
    console.log('🚀 INICIANDO TESTES DO MOTOR DE CONVERSÃO EM REUNIÕES');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    DatabaseService.clearAllClients();

    // ----------------------------------------------------
    // TESTE 1: Novo número de anúncio entra pelo WhatsApp
    // ----------------------------------------------------
    try {
        console.log('🧪 TESTE 1: Novo número entra pelo WhatsApp (origem anúncio)...');
        const phone1 = '31988887777';
        const msg1 = 'Olá Dr. Glaucio, vi seu anúncio no Instagram e preciso de ajuda';

        const reply1 = await TriageEngine.processIncoming(phone1, msg1, 'instance_1');
        const lead1 = DatabaseService.getClientByPhone(phone1);

        assert(lead1 !== null, 'Lead deveria ter sido criado no CRM');
        assert(lead1.phone === '5531988887777');
        assert(lead1.from_ad === 1);
        assert(lead1.status === 'NOVO LEAD');
        assert(reply1 && reply1.includes('qual área está relacionada'));

        console.log('✅ TESTE 1 PASSOU: Lead criado imediatamente no CRM.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 1 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 2: Lead abandona no meio da triagem
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 2: Lead responde área (Família) + pergunta 1 e abandona...');
        const phone2 = '31977776666';
        await TriageEngine.processIncoming(phone2, 'Olá Dr Glaucio, vi seu anúncio', 'instance_1');
        await TriageEngine.processIncoming(phone2, '3', 'instance_1');
        await TriageEngine.processIncoming(phone2, '1', 'instance_1');

        const lead2 = DatabaseService.getClientByPhone(phone2);
        assert(lead2.triage_answers.length === 1);
        assert(lead2.qualification_score > 0);

        console.log(`✅ TESTE 2 PASSOU: Respostas parciais salvas (${lead2.qualification_score} pts).`);
        passed++;
    } catch (e) {
        console.error('❌ TESTE 2 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 3: Retorno do lead sem duplicação
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 3: Lead do Teste 2 retorna após horas e continua...');
        const phone3 = '5531977776666';
        await TriageEngine.processIncoming(phone3, '1', 'instance_1');

        const matchingClients = DatabaseService.getAllClients().filter(c => DatabaseService.normalizePhone(c.phone) === '5531977776666');
        assert(matchingClients.length === 1);

        console.log('✅ TESTE 3 PASSOU: Continuação sem duplicidade de contato.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 3 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 4: Esclarecimento Completo + Conversão Direta em Reunião Agendada
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 4: Lead esclarecido na triagem e convertido em reunião agendada...');
        const phone4 = '31966665555';

        // 1. Entrada pelo anúncio
        await TriageEngine.processIncoming(phone4, 'Olá Dr Glaucio, vi o anúncio no Facebook', 'instance_1');
        // 2. Área: Trabalhista
        await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        // 3. Demitido
        await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        // 4. Já saí
        await TriageEngine.processIncoming(phone4, '2', 'instance_1');
        // 5. Menos de 30 dias
        await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        // 6. Possui documentos
        await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        // 7. Deseja orientação -> Responde com oferta de reunião Online vs Presencial!
        const replyFormat = await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        assert(replyFormat && replyFormat.includes('reunião com o Dr. Glaucio Dias'), 'Deveria propor a reunião com o Dr. Glaucio');

        // 8. Lead escolhe formato Online (1)
        const replySlots = await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        assert(replySlots && replySlots.includes('10:00'), 'Deveria oferecer horários disponíveis');

        // 9. Lead escolhe horário das 14:30 (2) -> REUNIÃO AGENDADA!
        const replyConfirmation = await TriageEngine.processIncoming(phone4, '2', 'instance_1');
        assert(replyConfirmation && replyConfirmation.includes('Reunião Online confirmada'), 'Deveria confirmar a reunião');
        assert(replyConfirmation.includes('meet.google.com'), 'Deveria conter o link do Google Meet');

        const lead4 = DatabaseService.getClientByPhone(phone4);
        assert(lead4.status === 'AGENDADO', `Status deveria ser AGENDADO, obtido: ${lead4.status}`);

        const appts = DatabaseService.getAllAppointments().filter(a => a.client_phone === '5531966665555');
        assert(appts.length === 1, 'Reunião deveria estar gravada na tabela de agendamentos');
        assert(appts[0].meeting_type === 'Online (Google Meet)', 'Tipo de reunião deve ser Online');

        console.log(`✅ TESTE 4 PASSOU: OBJETIVO ATINGIDO! Lead esclarecido e reunião agendada na agenda do Dr. Glaucio!`);
        passed++;
    } catch (e) {
        console.error('❌ TESTE 4 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 5: Status WhatsApp Confiável
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 5: Status confiável de todos os 5 WhatsApps...');
        const allStatus = getAllWhatsAppStatus();
        assert(allStatus.length === 5);
        console.log('✅ TESTE 5 PASSOU: 5 instâncias monitoradas.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 5 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 6: Idempotência de consulta
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 6: Consulta de estado persistida...');
        const s1 = getWhatsAppStatus('instance_1');
        const s2 = getWhatsAppStatus('instance_1');
        assert(s1.status === s2.status);
        console.log('✅ TESTE 6 PASSOU: Estado consistente.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 6 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 7: Mensagens simultâneas
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 7: Concorrência simultânea...');
        const phoneSimul = '31955554444';
        await Promise.all([
            TriageEngine.processIncoming(phoneSimul, 'Dr Glaucio anúncio 1', 'instance_1'),
            TriageEngine.processIncoming(phoneSimul, 'Dr Glaucio anúncio 2', 'instance_1')
        ]);
        const matching = DatabaseService.getAllClients().filter(c => DatabaseService.normalizePhone(c.phone) === '5531955554444');
        assert(matching.length === 1);
        console.log('✅ TESTE 7 PASSOU: Apenas 1 lead criado.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 7 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 8: Trava contra clientes antigos
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 8: Silêncio absoluto para clientes antigos / mensagens normais...');
        const phoneOld = '31944443333';
        const reply = await TriageEngine.processIncoming(phoneOld, 'Doutor, boa tarde! Como está o processo?', 'instance_1');
        assert(reply === null);
        console.log('✅ TESTE 8 PASSOU: IA em silêncio absoluto para contatos que não são de anúncios.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 8 FALHOU:', e.message);
        failed++;
    }

    DatabaseService.clearAllClients();
    console.log('\n🧹 Banco de dados pronto para produção.');

    console.log('\n====================================================');
    console.log(`📊 RESULTADO FINAL: ${passed} PASSARAM | ${failed} FALHARAM`);
    console.log('====================================================\n');

    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
