const DatabaseService = require('../database');
const config = require('../config');

const toolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'consultar_agenda',
            description: 'Consulta os horários livres disponíveis para reunião com o advogado em uma data específica.',
            parameters: {
                type: 'object',
                properties: {
                    data: {
                        type: 'string',
                        description: 'Data desejada no formato YYYY-MM-DD ou descrição como "segunda-feira", "amanhã", "2026-08-25".'
                    },
                    periodo: {
                        type: 'string',
                        enum: ['manha', 'tarde', 'qualquer'],
                        description: 'Período de preferência do cliente.'
                    }
                },
                required: ['data']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'criar_agendamento',
            description: 'Cria oficialmente a reunião na agenda do escritório após a confirmação expressa do cliente.',
            parameters: {
                type: 'object',
                properties: {
                    nome_cliente: { type: 'string', description: 'Nome completo do cliente.' },
                    telefone: { type: 'string', description: 'Telefone do cliente (WhatsApp).' },
                    data: { type: 'string', description: 'Data da reunião (ex: "Segunda-feira, 25/08/2026" ou "2026-08-25").' },
                    horario: { type: 'string', description: 'Horário da reunião (ex: "14:00" ou "10:30").' },
                    tipo_reuniao: { type: 'string', enum: ['Presencial', 'Online'], description: 'Formato escolhido pelo cliente (Presencial ou Online).' },
                    area_juridica: { type: 'string', description: 'Área do direito identificada (ex: Trabalhista, Família).' },
                    resumo: { type: 'string', description: 'Breve resumo do caso para a pauta da reunião.' },
                    observacoes: { type: 'string', description: 'Observações adicionais (ex: documentos que o cliente levará).' }
                },
                required: ['nome_cliente', 'telefone', 'data', 'horario', 'tipo_reuniao']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'atualizar_crm',
            description: 'Registra ou atualiza as informações do lead e triagem no banco de dados / CRM do escritório.',
            parameters: {
                type: 'object',
                properties: {
                    telefone: { type: 'string', description: 'Telefone do cliente.' },
                    nome: { type: 'string', description: 'Nome do cliente se informado.' },
                    cidade: { type: 'string', description: 'Cidade e Estado do cliente.' },
                    area_juridica: { type: 'string', description: 'Área jurídica identificada.' },
                    resumo: { type: 'string', description: 'Resumo estruturado dos fatos relatados.' },
                    urgencia: { type: 'string', enum: ['SIM', 'NÃO', 'A AVALIAR'], description: 'Se o caso apresenta urgência de prazos ou riscos.' },
                    documentos: { type: 'string', description: 'Documentos citados pelo cliente.' },
                    status: { type: 'string', enum: ['TRIAGEM', 'AGENDADO', 'AGUARDANDO_HUMANO', 'CONCLUIDO'], description: 'Status atual do atendimento.' }
                },
                required: ['telefone']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'encaminhar_humano',
            description: 'Transfere o atendimento para um advogado humano e desativa temporariamente a IA para esse cliente.',
            parameters: {
                type: 'object',
                properties: {
                    telefone: { type: 'string', description: 'Telefone do cliente.' },
                    motivo: { type: 'string', description: 'Motivo da transferência para o advogado.' }
                },
                required: ['telefone', 'motivo']
            }
        }
    }
];

async function executeTool(name, args, clientPhone) {
    console.log(`[TOOL EXECUTION] ${name}`, JSON.stringify(args));
    
    switch (name) {
        case 'consultar_agenda': {
            const dataInput = args.data || 'próximos dias';
            const appointmentsToday = DatabaseService.getAppointmentsForDate(dataInput);
            const occupiedTimes = appointmentsToday.map(a => a.time);

            const allSlots = ['09:30', '11:00', '14:00', '15:30', '17:00'];
            const freeSlots = allSlots.filter(s => !occupiedTimes.includes(s));

            return {
                status: 'sucesso',
                data_consultada: dataInput,
                horarios_disponiveis: freeSlots.length > 0 ? freeSlots : ['10:00 (Encaixe)', '16:00 (Encaixe)'],
                mensagem: `Horários livres encontrados para ${dataInput}: ${freeSlots.join(', ')}`
            };
        }

        case 'criar_agendamento': {
            const appointment = DatabaseService.createAppointment({
                phone: args.telefone || clientPhone,
                name: args.nome_cliente,
                date: args.data,
                time: args.horario,
                meeting_type: args.tipo_reuniao || 'Presencial',
                law_area: args.area_juridica,
                summary: args.resumo,
                notes: args.observacoes
            });

            return {
                status: 'agendado_com_sucesso',
                id_agendamento: appointment.id,
                tipo_reuniao: appointment.meeting_type,
                mensagem: `Reunião ${appointment.meeting_type} confirmada para ${args.data} às ${args.horario} com ${args.nome_cliente}.`
            };
        }

        case 'atualizar_crm': {
            const updated = DatabaseService.saveOrUpdateClient(args.telefone || clientPhone, {
                name: args.nome,
                city: args.cidade,
                law_area: args.area_juridica,
                summary: args.resumo,
                urgency: args.urgencia,
                documents: args.documentos,
                status: args.status
            });

            return {
                status: 'crm_atualizado',
                cliente: updated.name || 'Cliente',
                status_atual: updated.status
            };
        }

        case 'encaminhar_humano': {
            DatabaseService.setAiActive(args.telefone || clientPhone, false);
            DatabaseService.saveOrUpdateClient(args.telefone || clientPhone, {
                status: 'AGUARDANDO_HUMANO',
                summary: `Encaminhado para humano. Motivo: ${args.motivo}`
            });

            return {
                status: 'encaminhado_para_humano',
                mensagem: 'Atendimento transferido para a equipe humana. A IA foi pausada para este contato.'
            };
        }

        default:
            return { error: `Ferramenta ${name} não reconhecida.` };
    }
}

module.exports = {
    toolDefinitions,
    executeTool
};
