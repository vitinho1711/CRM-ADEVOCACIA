const TriageEngine = require('./src/agent/triageEngine');
const DatabaseService = require('./src/database');
const assert = require('assert');

async function runTests() {
    console.log('====================================================');
    console.log('🚀 TESTANDO: AGENDAMENTO FLEXÍVEL, MEET E CONVERSAÇÃO');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;
    const testPhone = '5531997875764';

    DatabaseService.deleteClient(testPhone);

    try {
        // ----------------------------------------------------
        // TESTE 1: ENTRADA E CAPTURA DE NOME E GMAIL
        // ----------------------------------------------------
        console.log('🧪 TESTE 1: Entrada do Lead e coleta de Nome e Gmail...');
        let reply = await TriageEngine.processIncoming(testPhone, 'Olá Dr. Glaucio, vi seu anúncio no Instagram');
        assert(reply.includes('qual é o seu Nome Completo'), 'Deveria pedir o Nome');
        assert(!reply.toLowerCase().includes('assistente virtual'), 'NÃO deve se apresentar como assistente virtual');
        assert(!reply.toLowerCase().includes('reunião') && !reply.toLowerCase().includes('reuniao'), 'NÃO deve falar de reunião no início');

        reply = await TriageEngine.processIncoming(testPhone, 'Vitor Batista de Oliveira');
        assert(reply.includes('qual é o seu melhor e-mail (Gmail)'), 'Deveria pedir o Gmail');
        assert(!reply.toLowerCase().includes('reunião') && !reply.toLowerCase().includes('reuniao'), 'NÃO deve falar de reunião na coleta de e-mail');

        reply = await TriageEngine.processIncoming(testPhone, 'vitor@gmail.com');
        assert(reply.includes('qual área está relacionada'), 'Deveria apresentar as áreas jurídicas');
        console.log('✅ TESTE 1 PASSOU: Nome e Gmail coletados humanamente (sem reunião e sem assistente virtual).\n');
        passed++;

        // ----------------------------------------------------
        // TESTE 2: TRIAGEM COM PERGUNTAS AMPLIADAS (FAMÍLIA)
        // ----------------------------------------------------
        console.log('🧪 TESTE 2: Triagem com perguntas aprofundadas (Família)...');
        // Escolhe Família (3)
        reply = await TriageEngine.processIncoming(testPhone, '3');
        assert(reply.includes('qual caso melhor representa'), 'Deveria iniciar perguntas de Família');

        // Situação: Divórcio (1)
        reply = await TriageEngine.processIncoming(testPhone, '1');
        assert(reply.includes('processo judicial'), 'Deveria perguntar de processo judicial');

        // Processo: Sim, já existe (1)
        reply = await TriageEngine.processIncoming(testPhone, '1');
        assert(reply.includes('filhos menores'), 'Deveria perguntar sobre filhos menores');

        // Filhos: Sim (1)
        reply = await TriageEngine.processIncoming(testPhone, '1');
        assert(reply.includes('bens ou patrimônio'), 'Deveria perguntar sobre bens a partilhar');

        // Bens: Imóvel (1)
        reply = await TriageEngine.processIncoming(testPhone, '1');
        assert(reply.includes('acordo amigável'), 'Deveria perguntar sobre possibilidade de acordo amigável');

        // Acordo: Chance de acordo (1)
        reply = await TriageEngine.processIncoming(testPhone, '1');
        assert(reply.includes('momento a situação se encontra'), 'Deveria perguntar o momento da situação');

        // Momento: Urgência em alimentos/bens (3)
        reply = await TriageEngine.processIncoming(testPhone, '3');
        assert(reply.includes('reunião com o Dr. Glaucio Dias'), 'Deveria convidar para a reunião de fechamento');
        console.log('✅ TESTE 2 PASSOU: Triagem ampliada completada com sucesso.\n');
        passed++;

        // ----------------------------------------------------
        // TESTE 3: ESCOLHA DE FORMATO E AGENDAMENTO FLEXÍVEL (13:00)
        // ----------------------------------------------------
        console.log('🧪 TESTE 3: Escolha do formato Online e horário customizado ("só posso às 13:00")...');
        // Escolhe Online (1)
        reply = await TriageEngine.processIncoming(testPhone, '1');
        assert(reply.includes('horários livres') || reply.includes('09:00 às 18:00'), 'Deveria apresentar horários livres');

        // Cliente pede horário específico: "vou ter horario somente as 13:00"
        reply = await TriageEngine.processIncoming(testPhone, 'vou ter horario somente as 13:00');
        assert(reply.includes('13:00'), 'Deveria confirmar às 13:00');
        assert(reply.includes('meet.google.com/gla-ucio-dia') || reply.includes('meet.google.com/'), 'Deveria conter link válido do Google Meet');
        assert(!reply.includes('glaucio-advocacia'), 'NÃO deve conter o link antigo que dava nome inválido');

        // Validação estrita do código do Google Meet
        const meetMatch = reply.match(/meet\.google\.com\/([a-z0-9-]+)/);
        assert(meetMatch, 'Deve ter link do Meet');
        const code = meetMatch[1];
        assert(/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code), `Código do Meet deve ter formato 3-4-3: ${code}`);

        console.log('✅ TESTE 3 PASSOU: Horário das 13:00 agendado e link do Google Meet 100% válido no padrão do Google!\n');
        passed++;

        // ----------------------------------------------------
        // TESTE 4: CONFLITO DE AGENDA (TENTAR AGENDAR O MESMO HORÁRIO)
        // ----------------------------------------------------
        console.log('🧪 TESTE 4: Verificação de conflito de agenda...');
        const nextDay = (function() {
            const d = new Date();
            d.setDate(d.getDate() + 1);
            if (d.getDay() === 6) d.setDate(d.getDate() + 2);
            if (d.getDay() === 0) d.setDate(d.getDate() + 1);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();

        const isAvailable13 = DatabaseService.isTimeSlotAvailable(nextDay, '13:00');
        assert.strictEqual(isAvailable13, false, 'O horário das 13:00 agora deve constar como OCUPADO');
        console.log('✅ TESTE 4 PASSOU: Conflito detectado com sucesso (13:00 ocupado).\n');
        passed++;

        // ----------------------------------------------------
        // TESTE 5: CONVERSAÇÃO NATURAL PÓS-AGENDAMENTO (SEM REINICIAR)
        // ----------------------------------------------------
        console.log('🧪 TESTE 5: Conversação natural pós-agendamento (sem reiniciar)...');
        
        // Pergunta sobre documentos
        reply = await TriageEngine.processIncoming(testPhone, 'Quais documentos preciso levar para a reunião?');
        assert(reply.includes('Documentos Pessoais') && reply.includes('Comprovantes'), 'Deveria responder sobre os documentos');
        assert(!reply.includes('qual é o seu Nome Completo'), 'NÃO deve reiniciar o cadastro');

        // Pergunta sobre endereço
        reply = await TriageEngine.processIncoming(testPhone, 'Onde fica o escritório em BH?');
        assert(reply.includes('Av. Abílio Machado, 1380'), 'Deveria informar o endereço');
        assert(!reply.includes('qual é o seu Nome Completo'), 'NÃO deve reiniciar');

        // Conversação livre
        reply = await TriageEngine.processIncoming(testPhone, 'Perfeito, muito obrigado!');
        assert(reply.includes('13:00') && reply.includes('Vitor'), 'Deveria confirmar a reunião mantendo a conversa fluida');
        assert(!reply.includes('qual é o seu Nome Completo'), 'NÃO deve reiniciar');

        console.log('✅ TESTE 5 PASSOU: Conversação contínua, humana e acolhedora sem reiniciar a triagem!\n');
        passed++;

    } catch (e) {
        console.error('❌ FALHA NO TESTE:', e);
        failed++;
    } finally {
        DatabaseService.deleteClient(testPhone);
        console.log('🧹 Limpeza de dados de teste concluída.');
    }

    console.log('====================================================');
    console.log(`📊 RESULTADO FINAL: ${passed} PASSARAM | ${failed} FALHARAM`);
    console.log('====================================================\n');
}

runTests();
