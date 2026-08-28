const assert = require('assert');
const path = require('path');
const DatabaseService = require('./src/database');
const TriageEngine = require('./src/agent/triageEngine');
const { getAllWhatsAppStatus, getWhatsAppStatus } = require('./src/integrations/whatsappDirect');
const Logger = require('./src/logger');

async function runTests() {
    console.log('====================================================');
    console.log('🚀 TESTANDO: FLUXO INTELIGENTE (WHATSAPP AUTOMÁTICO)');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    DatabaseService.clearAllClients();

    // ----------------------------------------------------
    // TESTE 1: Novo lead entra por anúncio -> WhatsApp capturado automaticamente e pede Nome
    // ----------------------------------------------------
    try {
        console.log('🧪 TESTE 1: Entrada de anúncio e captura automática de WhatsApp...');
        const realPhone = '5531997875764';
        const msgAd = 'Olá Dr. Glaucio, vi seu anúncio no Instagram';

        const r1 = await TriageEngine.processIncoming(realPhone, msgAd, 'instance_1');
        assert(r1 && r1.includes('qual é o seu Nome Completo'), 'Deveria pedir o Nome Completo');

        const lead1 = DatabaseService.getClientByPhone(realPhone);
        assert(lead1 !== null);
        assert(lead1.phone === '5531997875764');
        assert(lead1.triage_step === 'waiting_name');

        console.log('✅ TESTE 1 PASSOU: WhatsApp salvo automaticamente (+55 31 99787-5764) e Nome solicitado.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 1 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 2: Lead informa Nome -> Sistema NÃO pede WhatsApp e pede direto o Gmail
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 2: Lead envia Nome e sistema avança direto para o Gmail...');
        const realPhone = '5531997875764';
        const r2 = await TriageEngine.processIncoming(realPhone, 'Vitor Batista de Oliveira', 'instance_1');

        const lead1 = DatabaseService.getClientByPhone(realPhone);
        assert(lead1.name === 'Vitor Batista De Oliveira', `Nome salvo incorreto: ${lead1.name}`);
        assert(lead1.triage_step === 'waiting_email');
        assert(r2 && r2.includes('E-mail (Gmail)'), 'Deveria pedir o Gmail');
        assert(!r2.includes('qual é o seu número de WhatsApp'), 'NÃO deveria perguntar o WhatsApp novamente!');

        console.log('✅ TESTE 2 PASSOU: Nome salvo e sistema pediu direto o Gmail sem redundâncias.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 2 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 3: Lead envia Gmail -> Inicia seleção de área e triagem
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 3: Lead envia Gmail e inicia perguntas da causa...');
        const realPhone = '5531997875764';
        const r3 = await TriageEngine.processIncoming(realPhone, 'vitor@gmail.com', 'instance_1');

        const lead1 = DatabaseService.getClientByPhone(realPhone);
        assert(lead1.email === 'vitor@gmail.com');
        assert(lead1.triage_step === 'area_selection');
        assert(r3 && r3.includes('qual área está relacionada'));

        console.log('✅ TESTE 3 PASSOU: Gmail salvo e triagem jurídica iniciada.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 3 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 4: Triagem do Nicho + Agendamento com Sala Oficial do Google Meet
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 4: Agendamento com Sala Oficial do Google Meet e WhatsApp correto...');
        const realPhone = '5531997875764';

        // Escolhe Família (3)
        await TriageEngine.processIncoming(realPhone, '3', 'instance_1');
        // Divórcio (1)
        await TriageEngine.processIncoming(realPhone, '1', 'instance_1');
        // Processo em andamento: Sim (1)
        await TriageEngine.processIncoming(realPhone, '1', 'instance_1');
        // Bens: Sim, imóveis e veículos (1)
        await TriageEngine.processIncoming(realPhone, '1', 'instance_1');
        // Filhos menores: Sim (1)
        await TriageEngine.processIncoming(realPhone, '1', 'instance_1');
        // Urgência: Imediata (1) -> Conduz à escolha do formato!
        const rFormat = await TriageEngine.processIncoming(realPhone, '1', 'instance_1');
        assert(rFormat && rFormat.includes('Google Meet'));

        // Escolhe Online (1) -> Horários de 9h às 18h
        const rSlots = await TriageEngine.processIncoming(realPhone, '1', 'instance_1');
        assert(rSlots && rSlots.includes('09:00 às 18:00'));

        // Escolhe 14:00 (opção 3) -> Confirmação da Reunião!
        const rConfirm = await TriageEngine.processIncoming(realPhone, '3', 'instance_1');
        assert(rConfirm && rConfirm.includes('Reunião Online Agendada'));
        assert(rConfirm.includes('+55 (31) 99787-5764'), 'Deveria exibir o WhatsApp real');
        assert(rConfirm.includes('meet.google.com/'), 'Deveria conter o link da sala do Meet');

        const appt = DatabaseService.getAllAppointments().find(a => a.client_name === 'Vitor Batista De Oliveira');
        assert(appt !== undefined);
        assert(appt.client_phone === '5531997875764', `Telefone na agenda deveria ser o real, obtido: ${appt.client_phone}`);

        console.log(`✅ TESTE 4 PASSOU: Reunião agendada com WhatsApp real (+55 31 99787-5764) e sala do Google Meet!`);
        passed++;
    } catch (e) {
        console.error('❌ TESTE 4 FALHOU:', e.message);
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
