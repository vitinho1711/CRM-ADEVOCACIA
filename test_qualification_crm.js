const assert = require('assert');
const path = require('path');
const DatabaseService = require('./src/database');
const TriageEngine = require('./src/agent/triageEngine');
const { getAllWhatsAppStatus, getWhatsAppStatus } = require('./src/integrations/whatsappDirect');
const Logger = require('./src/logger');

async function runTests() {
    console.log('====================================================');
    console.log('🚀 TESTANDO: NOME + WHATSAPP REAL + GMAIL + MEET REAL');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    DatabaseService.clearAllClients();

    // ----------------------------------------------------
    // TESTE 1: Novo lead entra por anúncio -> Sistema pede Nome Completo
    // ----------------------------------------------------
    try {
        console.log('🧪 TESTE 1: Entrada de anúncio e pedido de Nome Completo...');
        const phone1 = '48885988860035'; // Simula o LID do WhatsApp
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
    // TESTE 2: Lead informa Nome -> Sistema pede o número do WhatsApp com DDD
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 2: Lead envia Nome e sistema pede o WhatsApp com DDD...');
        const phone1 = '48885988860035';
        const r2 = await TriageEngine.processIncoming(phone1, 'Vitor Batista de Oliveira', 'instance_1');

        const lead1 = DatabaseService.getClientByPhone(phone1);
        assert(lead1.name === 'Vitor Batista De Oliveira', `Nome salvo incorreto: ${lead1.name}`);
        assert(lead1.triage_step === 'waiting_phone');
        assert(r2 && r2.includes('número de WhatsApp com DDD'), 'Deveria pedir o WhatsApp com DDD');

        console.log('✅ TESTE 2 PASSOU: Nome salvo e WhatsApp solicitado explicitamente.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 2 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 3: Lead digita o WhatsApp -> Sistema confirma o número e pede o Gmail
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 3: Lead envia WhatsApp real e sistema pede Gmail...');
        const phone1 = '48885988860035';
        const r3 = await TriageEngine.processIncoming(phone1, '31 98888-7777', 'instance_1');

        const lead1 = DatabaseService.getClientByPhone(phone1);
        assert(lead1.phone_contact === '5531988887777', `WhatsApp de contato salvo incorreto: ${lead1.phone_contact}`);
        assert(lead1.triage_step === 'waiting_email');
        assert(r3 && r3.includes('E-mail (Gmail)'), 'Deveria pedir o e-mail Gmail');
        assert(r3 && r3.includes('+55 (31) 98888-7777'), 'Deveria confirmar o número real');

        console.log('✅ TESTE 3 PASSOU: WhatsApp real salvo e Gmail solicitado.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 3 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 4: Lead envia Gmail -> Inicia seleção de área e triagem
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 4: Lead envia Gmail e inicia perguntas da causa...');
        const phone1 = '48885988860035';
        const r4 = await TriageEngine.processIncoming(phone1, 'vitor@gmail.com', 'instance_1');

        const lead1 = DatabaseService.getClientByPhone(phone1);
        assert(lead1.email === 'vitor@gmail.com');
        assert(lead1.triage_step === 'area_selection');
        assert(r4 && r4.includes('qual área está relacionada'));

        console.log('✅ TESTE 4 PASSOU: Gmail salvo e triagem jurídica iniciada.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 4 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 5: Triagem do Nicho + Agendamento com Sala Oficial do Google Meet
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 5: Agendamento com Sala Oficial do Google Meet...');
        const phone1 = '48885988860035';

        // Escolhe Família (3)
        await TriageEngine.processIncoming(phone1, '3', 'instance_1');
        // Divórcio (1)
        await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        // Processo em andamento: Sim (1)
        await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        // Bens: Sim, imóveis e veículos (1)
        await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        // Filhos menores: Sim (1)
        await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        // Urgência: Imediata (1) -> Conduz à escolha do formato!
        const rFormat = await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        assert(rFormat && rFormat.includes('Google Meet'));

        // Escolhe Online (1) -> Horários de 9h às 18h
        const rSlots = await TriageEngine.processIncoming(phone1, '1', 'instance_1');
        assert(rSlots && rSlots.includes('09:00 às 18:00'));

        // Escolhe 14:00 (opção 3) -> Confirmação da Reunião!
        const rConfirm = await TriageEngine.processIncoming(phone1, '3', 'instance_1');
        assert(rConfirm && rConfirm.includes('Reunião Online Agendada'));
        assert(rConfirm.includes('+55 (31) 98888-7777'), 'Deveria exibir o WhatsApp real e não o LID');
        assert(rConfirm.includes('meet.google.com/'), 'Deveria conter o link da sala do Meet');

        const appt = DatabaseService.getAllAppointments().find(a => a.client_name === 'Vitor Batista De Oliveira');
        assert(appt !== undefined);
        assert(appt.client_phone === '5531988887777', `Telefone na agenda deveria ser o real, obtido: ${appt.client_phone}`);

        console.log(`✅ TESTE 5 PASSOU: Reunião agendada com WhatsApp real (+55 31 98888-7777) e sala do Google Meet!`);
        passed++;
    } catch (e) {
        console.error('❌ TESTE 5 FALHOU:', e.message);
        failed++;
    }

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
