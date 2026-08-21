# 🏛️ Automação de WhatsApp com IA — Glaucio Dias Advocacia

Sistema completo de atendimento inteligente com Inteligência Artificial para o escritório **Glaucio Dias Advocacia**, com triagem jurídica, agendamento de reuniões, CRM de leads e Painel de Controle Web.

---

## ⚡ Como Iniciar em 3 Minutos

### 1. Instalar as dependências
Abra o terminal nesta pasta e execute:
```bash
npm install
```

### 2. Configurar suas Chaves no arquivo `.env`
Abra o arquivo `.env` e insira sua chave da OpenAI (`OPENAI_API_KEY`) e o número de WhatsApp do advogado.

### 3. Iniciar o Servidor da Automação
```bash
npm start
```
O painel administrativo abrirá em: **http://localhost:8000**

---

## 📱 Como Conectar o seu WhatsApp (Evolution API)

Você pode rodar a Evolution API com Docker:
```bash
docker compose up -d
```

1. Acesse o gerenciador da Evolution API em `http://localhost:8080`
2. Crie uma nova instância chamada `glaucio_advocacia`
3. Aponte o Webhook para: `http://host.docker.internal:8000/webhook/evolution`
4. Escaneie o **QR Code** no seu WhatsApp e pronto!

---

## 📊 Recursos do Painel Web (Dashboard)
- **CRM em Tempo Real**: Veja todos os clientes em triagem, seus resumos, área do direito e cidade.
- **Visualizador de Chat ao Vivo**: Acompanhe o que o bot está conversando com cada cliente.
- **Transbordo Humano**: Assuma a conversa a qualquer momento com um clique no botão "Pausar IA".
- **Respostas Manuais**: Envie mensagens do WhatsApp diretamente pelo painel.
