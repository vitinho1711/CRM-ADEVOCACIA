const assert = require('assert');
const path = require('path');
const DatabaseService = require('./src/database');
const TriageEngine = require('./src/agent/triageEngine');
const { getAllWhatsAppStatus, getWhatsAppStatus } = require('./src/integrations/whatsappDirect');
const Logger = require('./src/logger');

async function runTests() {
    console.log('====================================================');
    console.log('🚀 TESTANDO FLUXO COMPLETO: NOME + GMAIL + 09H-18H + MEET + FOLLOW-UP');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    DatabaseService.clearAllClients();

    // ----------------------------------------------------
    // TESTE 1: Novo lead entra por anúncio -> Sistema pede Nome Completo
    // ----------------------------------------------------
    try {
        console.log('🧪 TESTE 1: Entrada de anúncio e pedido de Nome Completo...');
        const phone1 = '31988887777';
        const msgAd = 'Olá Dr. Glaucio, vi seu anúncio no Instagram';

        const r1 = await TriageEngine.processIncoming(phone1, msgAd, 'instance_1');
        assert(r1 && r1.includes('qual é o seu Nome Completo'), 'Deveria pedir o Nome Completo');

        const lead1 = DatabaseService.getClientByPhone(phone1);
        assert(lead1 !== null);
        assert(lead1.triage_step === 'waiting_name');

        console.log('✅ TESTE 1 PASSOU: Sistema solicita o Nome Completo logo na entrada.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 1 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 2: Lead informa Nome -> Sistema confirma Telefone e pede Gmail
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 2: Lead envia Nome e sistema pede E-mail / Gmail...');
        const phone1 = '31988887777';
        const r2 = await TriageEngine.processIncoming(phone1, 'Carlos Eduardo da Silva', 'instance_1');

        const lead1 = DatabaseService.getClientByPhone(phone1);
        assert(lead1.name === 'Carlos Eduardo Da Silva', `Nome salvo incorreto: ${lead1.name}`);
        assert(lead1.triage_step === 'waiting_email');
        assert(r2 && r2.includes('E-mail (Gmail)'), 'Deveria pedir o e-mail Gmail');
        assert(r2 && r2.includes('+55 (31) 98888-7777'), 'Deveria confirmar o telefone');

        console.log('✅ TESTE 2 PASSOU: Nome salvo, telefone confirmado e Gmail solicitado.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 2 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 3: Lead informa Gmail -> Salva no CRM e inicia seleção de área
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 3: Lead envia Gmail e sistema avança para as perguntas...');
        const phone1 = '31988887777';
        const r3 = await TriageEngine.processIncoming(phone1, 'carlos.adv@gmail.com', 'instance_1');

        const lead1 = DatabaseService.getClientByPhone(phone1);
        assert(lead1.email === 'carlos.adv@gmail.com', `Email salvo incorreto: ${lead1.email}`);
        assert(lead1.triage_step === 'area_selection');
        assert(r3 && r3.includes('qual área está relacionada'), 'Deveria apresentar as opções de área');

        console.log('✅ TESTE 3 PASSOU: Gmail salvo com sucesso na ficha do lead.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 3 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 4: Triagem do Nicho + Agendamento com Horários das 09:00 às 18:00 + Meet Link Único
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 4: Condução para Reunião de 09:00 às 18:00 com Google Meet Automático...');
        const phone1 = '31988887777';

        // Escolhe Trabalhista (1)
        await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        // Demitido (1)
        await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        // Não trabalha mais (2)
        await TriageEngine.processIncoming(phone1, '2', 'instance_1');
        // Menos de 30 dias (1)
        await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        // Possui documentos (1)
        await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        // Deseja agendamento (1) -> Conduz à escolha do formato!
        const rFormat = await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        assert(rFormat && rFormat.includes('Google Meet'), 'Deveria oferecer Online vs Presencial');

        // Escolhe Online (1) -> Disponibiliza horários das 09:00 às 18:00
        const rSlots = await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        assert(rSlots && rSlots.includes('09:00 às 18:00'), 'Deveria mencionar o intervalo das 09:00 às 18:00');
        assert(rSlots.includes('09:30') && rSlots.includes('17:00'), 'Deveria conter opções de manhã e tarde');

        // Escolhe horário das 14:00 (opção 3) -> Reunião Criada com Meet e Follow-up!
        const rConfirm = await TriageEngine.processIncoming(phone1, '3', 'instance_1');
        assert(rConfirm && rConfirm.includes('Reunião Online Agendada'), 'Deveria confirmar a reunião');
        assert(rConfirm.includes('meet.google.com/'), 'Deveria gerar o link do Google Meet');
        assert(rConfirm.includes('FOLLOW-UP & ORIENTAÇÕES'), 'Deveria incluir orientações de follow-up');

        const leadFinal = DatabaseService.getClientByPhone(phone1);
        assert(leadFinal.status === 'AGENDADO');

        const appt = DatabaseService.getAllAppointments().find(a => a.client_phone === '5531988887777');
        assert(appt !== undefined, 'Agendamento não encontrado no banco');
        assert(appt.client_name === 'Carlos Eduardo Da Silva');
        assert(appt.client_email === 'carlos.adv@gmail.com');
        assert(appt.meet_link && appt.meet_link.startsWith('https://meet.google.com/'), 'Link do Meet inválido');
        assert(appt.followup_count >= 1, 'Follow-up inicial deveria estar registrado');

        console.log(`✅ TESTE 4 PASSOU: Agendamento completo! Meet: ${appt.meet_link}, Horário: ${appt.time} (Janela 9h-18h).`);
        passed++;
    } catch (e) {
        console.error('❌ TESTE 4 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 5: Registro de Disparo de Follow-up no WhatsApp
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 5: Teste de registro de follow-up adicional do WhatsApp...');
        const appt = DatabaseService.getAllAppointments()[0];
        assert(appt !== undefined);

        const updatedAppt = DatabaseService.registerFollowUpSent(appt.id);
        assert(updatedAppt.followup_count === 2, 'Contador de follow-up deveria ter subido para 2');

        console.log('✅ TESTE 5 PASSOU: Registro e histórico de follow-up funcionando perfeitamente.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 5 FALHOU:', e.message);
        failed++;
    }

    // Limpa banco de testes
    DatabaseService.clearAllClients();
    console.log('\n🧹 Banco de dados zerado para produção.');

    console.log('\n====================================================');
    console.log(`📊 RESULTADO FINAL: ${passed} PASSARAM | ${failed} FALHARAM`);
    console.log('====================================================\n');

    if (failed > 0) process.exit(1);
}

runTests().catch(err => {
    console.error(err);
    process.exit(1);
});
