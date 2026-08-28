const assert = require('assert');
const path = require('path');
const DatabaseService = require('./src/database');
const TriageEngine = require('./src/agent/triageEngine');
const { getAllWhatsAppStatus, getWhatsAppStatus } = require('./src/integrations/whatsappDirect');
const Logger = require('./src/logger');

async function runTests() {
    console.log('====================================================');
    console.log('🚀 INICIANDO SUÍTE DOS 8 TESTES OBRIGATÓRIOS DO CRM');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    // Limpa banco de testes preliminar
    DatabaseService.clearAllClients();

    // ----------------------------------------------------
    // TESTE 1: Novo número de anúncio entra pelo WhatsApp
    // Resultado esperado: Lead criado automaticamente no CRM
    // ----------------------------------------------------
    try {
        console.log('🧪 TESTE 1: Novo número entra pelo WhatsApp (origem anúncio)...');
        const phone1 = '31988887777';
        const msg1 = 'Olá Dr. Glaucio, vi seu anúncio no Instagram e preciso de ajuda';

        const reply1 = await TriageEngine.processIncoming(phone1, msg1, 'instance_1');
        const lead1 = DatabaseService.getClientByPhone(phone1);

        assert(lead1 !== null, 'Lead deveria ter sido criado no CRM');
        assert(lead1.phone === '5531988887777', `Telefone deveria estar normalizado para 5531988887777, obtido: ${lead1.phone}`);
        assert(lead1.from_ad === 1, 'Lead deve estar marcado como from_ad = 1');
        assert(lead1.status === 'NOVO LEAD', `Status inicial esperado: NOVO LEAD, obtido: ${lead1.status}`);
        assert(reply1 && reply1.includes('qual área está relacionada'), 'Deveria retornar a pergunta de seleção de área');

        console.log('✅ TESTE 1 PASSOU: Lead criado imediatamente no CRM com normalização e pergunta de área enviada.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 1 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 2: Lead abandona a triagem após responder 2 perguntas
    // Resultado esperado: Lead permanece salvo com respostas parciais e score parcial
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 2: Lead responde área (Família) + pergunta 1 e abandona...');
        const phone2 = '31977776666';
        
        // 1. Mensagem de anúncio
        await TriageEngine.processIncoming(phone2, 'Olá Dr Glaucio, vi seu anúncio', 'instance_1');
        
        // 2. Responde área Família (opção 3)
        await TriageEngine.processIncoming(phone2, '3', 'instance_1');

        // 3. Responde primeira pergunta de Família: Divórcio (opção 1)
        await TriageEngine.processIncoming(phone2, '1', 'instance_1');

        // Lead para de responder aqui!
        const lead2 = DatabaseService.getClientByPhone(phone2);
        assert(lead2 !== null, 'Lead deveria existir no CRM');
        assert(lead2.law_area === 'Direito de Família', `Área deveria ser Direito de Família, obtida: ${lead2.law_area}`);
        assert(lead2.triage_answers.length === 1, `Deveria ter 1 resposta salva na triagem, obtidas: ${lead2.triage_answers.length}`);
        assert(lead2.qualification_score > 0, `Score parcial deveria ser > 0, obtido: ${lead2.qualification_score}`);
        assert(lead2.triage_step === 'familia_processo', `Próxima etapa deveria ser familia_processo, obtida: ${lead2.triage_step}`);

        console.log(`✅ TESTE 2 PASSOU: Respostas parciais salvas! Score parcial: ${lead2.qualification_score} pts, Etapa: ${lead2.triage_step}.`);
        passed++;
    } catch (e) {
        console.error('❌ TESTE 2 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 3: Lead retorna depois de algumas horas
    // Resultado esperado: Identifica o mesmo telefone e continua de onde parou sem duplicar
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 3: Lead do Teste 2 retorna após horas e continua...');
        const phone3 = '5531977776666'; // Mesmo telefone formatado diferente
        
        // Responde pergunta 2 de Família: "Sim, já existe processo" (opção 1)
        const replyContinue = await TriageEngine.processIncoming(phone3, '1', 'instance_1');

        const allClientsWithPhone = DatabaseService.getAllClients().filter(c => DatabaseService.normalizePhone(c.phone) === '5531977776666');
        assert(allClientsWithPhone.length === 1, `Não pode duplicar lead! Encontrados: ${allClientsWithPhone.length}`);

        const lead3 = DatabaseService.getClientByPhone(phone3);
        assert(lead3.triage_answers.length === 2, `Deveria ter 2 respostas acumuladas, obtidas: ${lead3.triage_answers.length}`);
        assert(lead3.triage_step === 'familia_bens', `Deveria avançar para familia_bens, obtida: ${lead3.triage_step}`);
        assert(replyContinue && replyContinue.includes('bens'), 'Deveria enviar a pergunta sobre bens');

        console.log('✅ TESTE 3 PASSOU: Lead identificado pelo telefone normalizado, sem duplicação e continuou o fluxo.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 3 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 4: Lead conclui a triagem completa
    // Resultado esperado: Score calculado, área definida, status atualizado
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 4: Lead conclui todo o fluxo de triagem...');
        const phone4 = '31966665555';

        // 1. Anúncio geral
        await TriageEngine.processIncoming(phone4, 'Olá Dr Glaucio, vi seu anúncio no Facebook', 'instance_1');
        // 2. Escolhe Trabalhista (opção 1)
        await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        // 3. Situação: Fui demitido (opção 1)
        await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        // 4. Vínculo: Não, já saí (opção 2)
        await TriageEngine.processIncoming(phone4, '2', 'instance_1');
        // 5. Tempo: Menos de 30 dias (opção 1)
        await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        // 6. Documentos: Sim, possui documentos (opção 1)
        await TriageEngine.processIncoming(phone4, '1', 'instance_1');
        // 7. Deseja agendamento: Sim (opção 1) -> Conclusão da triagem!
        const finalReply = await TriageEngine.processIncoming(phone4, '1', 'instance_1');

        const lead4 = DatabaseService.getClientByPhone(phone4);
        assert(lead4.triage_step === 'completed', `Etapa final deveria ser completed, obtida: ${lead4.triage_step}`);
        assert(lead4.qualification_score >= 80, `Score final deveria ser >= 80, obtido: ${lead4.qualification_score}`);
        assert(lead4.qualification_status === 'ALTA PRIORIDADE' || lead4.qualification_status === 'QUALIFICADO', `Status de qualificação inesperado: ${lead4.qualification_status}`);
        assert(finalReply && (finalReply.includes('Presencial') || finalReply.includes('agendar')), 'Deveria oferecer opções de agendamento');

        console.log(`✅ TESTE 4 PASSOU: Triagem concluída com sucesso! Score: ${lead4.qualification_score}/100, Classificação: ${lead4.qualification_status}.`);
        passed++;
    } catch (e) {
        console.error('❌ TESTE 4 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 5: Status de Conexão do WhatsApp
    // Resultado esperado: Retorna status válido (CONNECTED, CONNECTING ou DISCONNECTED) sem loop infinito
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 5: Checagem dos estados de conexão do WhatsApp...');
        const allStatus = getAllWhatsAppStatus();
        assert(Array.isArray(allStatus), 'Deveria retornar array de instâncias');
        assert(allStatus.length === 5, `Deveria ter 5 instâncias, obtidas: ${allStatus.length}`);

        const validStatuses = ['CONNECTED', 'CONNECTING', 'DISCONNECTED', 'RECONNECTING', 'ERROR'];
        allStatus.forEach(inst => {
            assert(validStatuses.includes(inst.status), `Status inválido encontrado: ${inst.status}`);
        });

        console.log('✅ TESTE 5 PASSOU: Todos os 5 WhatsApps retornam estados confiáveis padronizados.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 5 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 6: Atualização da página (F5) / Persistência do Status
    // Resultado esperado: Consulta ao estado real sem reverter para estado falso
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 6: Persistência do estado de conexão ao recarregar...');
        const status1 = getWhatsAppStatus('instance_1');
        const status2 = getWhatsAppStatus('instance_1');
        assert(status1.status === status2.status, 'Status deve ser idempotente e consistente entre chamadas');

        console.log(`✅ TESTE 6 PASSOU: Estado consistente consultado diretamente da fonte (${status1.status}).`);
        passed++;
    } catch (e) {
        console.error('❌ TESTE 6 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 7: Duas mensagens simultâneas do mesmo número
    // Resultado esperado: Apenas 1 lead criado no banco de dados
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 7: Prevenção de duplicação em mensagens simultâneas...');
        const phoneSimul = '31955554444';
        
        // Dispara 2 mensagens simultaneamente com Promise.all
        await Promise.all([
            TriageEngine.processIncoming(phoneSimul, 'Olá Dr Glaucio anúncio 1', 'instance_1'),
            TriageEngine.processIncoming(phoneSimul, 'Olá Dr Glaucio anúncio 2', 'instance_1')
        ]);

        const matchingClients = DatabaseService.getAllClients().filter(c => DatabaseService.normalizePhone(c.phone) === '5531955554444');
        assert(matchingClients.length === 1, `Condição de corrida! Criou ${matchingClients.length} leads em vez de 1.`);

        console.log('✅ TESTE 7 PASSOU: Trava de concorrência e normalização impediram duplicidade.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 7 FALHOU:', e.message);
        failed++;
    }

    // ----------------------------------------------------
    // TESTE 8: Trava contra clientes antigos / mensagens não-anúncio
    // Resultado esperado: IA permanece 100% em silêncio para contatos que não são de anúncio
    // ----------------------------------------------------
    try {
        console.log('\n🧪 TESTE 8: Proteção contra resposta a clientes antigos ou mensagens normais...');
        const phoneOld = '31944443333';
        
        // Mensagem normal que NÃO é de anúncio (ex: amigo ou cliente antigo perguntando do processo)
        const replyNonAd = await TriageEngine.processIncoming(phoneOld, 'Doutor, boa tarde! Como está meu processo?', 'instance_1');
        
        assert(replyNonAd === null, 'A IA NÃO DEVE RESPONDER mensagens que não vieram de anúncio!');
        
        const leadOld = DatabaseService.getClientByPhone(phoneOld);
        assert(leadOld.from_ad === 0, 'Contato deve estar marcado como from_ad = 0');
        assert(leadOld.ai_active === 0, 'A IA deve estar desativada (ai_active = 0) para este contato');

        console.log('✅ TESTE 8 PASSOU: Proteção total! Clientes antigos e mensagens normais são 100% ignoradas pela IA.');
        passed++;
    } catch (e) {
        console.error('❌ TESTE 8 FALHOU:', e.message);
        failed++;
    }

    // Limpa banco de testes para deixar 100% limpo em produção
    DatabaseService.clearAllClients();
    console.log('\n🧹 Banco de dados de produção resetado para estado limpo e pronto.');

    console.log('\n====================================================');
    console.log(`📊 RESULTADO FINAL: ${passed} PASSARAM | ${failed} FALHARAM`);
    console.log('====================================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
});
