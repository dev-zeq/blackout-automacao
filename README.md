# Lan Blackout — API (backend)

Servidor que liga o site de documentos da Lan Blackout às ferramentas externas, **mantendo as chaves seguras** (elas ficam só no servidor, nunca no navegador).

Ele faz 3 coisas:

| Recurso | Endpoint | O que faz |
|---|---|---|
| Revisar textos | `POST /api/revisar` | Corrige ortografia/gramática do currículo usando a **Grok (xAI)** |
| Gerar Pix | `POST /api/pix` | Cria um pagamento **Pix no Mercado Pago** e devolve o QR Code |
| Conferir Pix | `GET /api/pix/:id` | Diz se o Pix já foi pago (`pending` → `approved`) |
| Enviar contrato | `POST /api/solicitar` | Manda os dados dos documentos jurídicos pro **n8n** |

---

## 1. O que você precisa

- **Node.js 18 ou mais novo** (recomendado 20+). Veja sua versão com `node -v`.
- Uma **chave da Grok (xAI)** → https://console.x.ai  *(gere uma nova!)*
- Um **Access Token do Mercado Pago** → https://www.mercadopago.com.br/developers/panel
- A **URL de um webhook no n8n** (a que recebe os pedidos).

> Você pode começar **sem o Mercado Pago e sem o n8n** — o servidor sobe do mesmo jeito e só esses recursos ficam desligados até você preencher.

---

## 2. Rodar no seu computador (teste)

```bash
# 1. instalar as dependências
npm install

# 2. criar o arquivo de configuração
cp .env.example .env
#    abra o .env e preencha as chaves

# 3. iniciar
npm start
```

Abra http://localhost:3000/ — se aparecer um JSON com `"ok": true`, está funcionando.

Para ver mudanças no código sem reiniciar na mão: `npm run dev`.

---

## 3. Preencher o `.env`

```
PORT=3000
ALLOWED_ORIGIN=*          # em produção, troque pelo domínio do site
XAI_API_KEY=...           # chave NOVA da xAI
XAI_MODEL=grok-3-mini     # use o modelo mais barato do seu console
MP_ACCESS_TOKEN=...       # comece com as credenciais de TESTE
N8N_WEBHOOK_URL=...        # webhook do n8n
```

**Importante:** o arquivo `.env` nunca vai pro GitHub (já está no `.gitignore`). É assim que as chaves ficam seguras.

---

## 4. Conectar com o site (frontend)

No arquivo `blackout-documentos.html`, lá no topo do `<script>`, coloque o endereço do backend:

```js
const API_BASE = 'http://localhost:3000';   // em produção: https://api.seusite.com
```

- Com `API_BASE` **vazio** → o site roda em **modo demonstração** (Pix simulado, IA pela prévia do Claude).
- Com `API_BASE` **preenchido** → o site usa o **backend de verdade**: revisão pela Grok e Pix real pelo Mercado Pago.

---

## 5. Publicar (deixar no ar)

Qualquer serviço que roda Node serve. Os mais fáceis:

- **Render** (render.com) ou **Railway** (railway.app): conecte o repositório do GitHub, defina as variáveis de ambiente (as mesmas do `.env`) e pronto. Comando de start: `npm start`.
- **VPS** (ex: uma máquina na Hostinger/Contabo): instale Node, suba os arquivos, configure o `.env` e rode com `pm2 start server.js`.

Depois de publicado, atualize:
- `ALLOWED_ORIGIN` no `.env` → domínio do site.
- `API_BASE` no `blackout-documentos.html` → endereço do backend.

---

## 6. Testando o Pix

Use primeiro as **credenciais de teste** do Mercado Pago e crie um "usuário de teste vendedor".
Atenção: com usuário de teste, o Pix é **gerado** (QR + código) mas o Mercado Pago **não deixa aprovar** o pagamento de teste — então o status fica em `pending`. Com as credenciais **de produção**, o fluxo completa normalmente.

---

## Segurança (resumo)

- As chaves ficam **só no servidor**, no `.env`. O navegador nunca as vê.
- `/api/revisar` tem limite de 10 chamadas por minuto por IP, pra proteger seu crédito da Grok.
- Nunca cole chaves de API direto no HTML/JS nem mande pra ninguém por mensagem.
