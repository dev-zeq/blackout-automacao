/* =====================================================================
   Lan Blackout — API (backend)
   ---------------------------------------------------------------------
   Faz 3 coisas, com as chaves seguras no servidor (NUNCA no navegador):
     1) POST /api/revisar     -> corrige textos do currículo com a Grok (xAI)
     2) POST /api/pix         -> gera um pagamento Pix no Mercado Pago
        GET  /api/pix/:id      -> consulta se o Pix já foi pago
     3) POST /api/solicitar   -> envia os dados dos contratos para o n8n

   Configuração: copie o arquivo ".env.example" para ".env" e preencha.
   Rodar local:  npm install  &&  npm start
   ===================================================================== */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { MercadoPagoConfig, Payment } from 'mercadopago';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PDF_DIR = join(__dirname, 'public', 'pdfs');
mkdirSync(PDF_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));

/* ---- CORS: libera o seu site a chamar a API ----
   Em produção, coloque o domínio do site em ALLOWED_ORIGIN (ex: https://documentos.lanblackout.com).
   Em testes pode deixar "*". */
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

/* ---- Mercado Pago: só inicializa se o token estiver configurado ---- */
let mpPayment = null;
if (process.env.MP_ACCESS_TOKEN) {
  const mp = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN, options: { timeout: 8000 } });
  mpPayment = new Payment(mp);
}

/* ---- Página inicial: confere se está no ar ---- */
app.get('/', (req, res) => {
  res.json({
    ok: true,
    servico: 'Lan Blackout API',
    grok: !!process.env.XAI_API_KEY,
    mercadopago: !!mpPayment,
    n8n: !!process.env.N8N_WEBHOOK_URL,
    endpoints: ['POST /api/revisar', 'POST /api/pix', 'GET /api/pix/:id', 'POST /api/solicitar']
  });
});

/* =====================================================================
   1) REVISAR TEXTOS COM A GROK (xAI)
   ===================================================================== */

// Limita o uso para proteger seu crédito (10 chamadas por minuto por IP).
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas revisões seguidas. Aguarde alguns segundos.' }
});

app.post('/api/revisar', aiLimiter, async (req, res) => {
  try {
    if (!process.env.XAI_API_KEY) {
      return res.status(500).json({ erro: 'XAI_API_KEY não configurada no servidor.' });
    }

    const { resumo = '', experiencias = [] } = req.body || {};
    const exps = Array.isArray(experiencias) ? experiencias : [];
    const temResumo = String(resumo || '').trim().length > 0;
    const temExp = exps.some(x => x && x.descricao && String(x.descricao).trim());
    if (!temResumo && !temExp) {
      return res.status(400).json({ erro: 'Nada para revisar.' });
    }

    const payload = {
      resumo: String(resumo || ''),
      experiencias: exps
        .filter(x => x && x.descricao && String(x.descricao).trim())
        .map(x => ({ id: x.id, descricao: String(x.descricao) }))
    };

    const sistema =
      'Você é um revisor profissional de currículos em português do Brasil. ' +
      'Corrija ortografia, acentuação, gramática e pontuação, e melhore levemente o tom para ficar profissional e objetivo. ' +
      'NÃO invente informações novas, mantenha o sentido original e um tamanho parecido. ' +
      'Responda APENAS com um JSON válido, sem markdown e sem comentários, no formato exato: ' +
      '{"resumo":"texto revisado","experiencias":[{"id":"...","descricao":"texto revisado"}]}. ' +
      'Mantenha os "id" exatamente como recebidos.';

    // A API da xAI é compatível com o formato da OpenAI.
    const r = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.XAI_MODEL || 'grok-3-mini',
        temperature: 0.3,
        messages: [
          { role: 'system', content: sistema },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      })
    });

    if (!r.ok) {
      const detalhe = await r.text();
      console.error('Erro xAI:', r.status, detalhe);
      return res.status(502).json({ erro: 'Falha ao revisar com a IA.' });
    }

    const data = await r.json();
    const texto = data?.choices?.[0]?.message?.content || '';
    const ini = texto.indexOf('{');
    const fim = texto.lastIndexOf('}');
    if (ini === -1 || fim === -1) {
      return res.status(502).json({ erro: 'Resposta inválida da IA.' });
    }

    const revisado = JSON.parse(texto.slice(ini, fim + 1));
    res.json(revisado); // { resumo, experiencias }
  } catch (err) {
    console.error('revisar:', err);
    res.status(500).json({ erro: 'Erro interno ao revisar.' });
  }
});

/* =====================================================================
   2) PAGAMENTO PIX (Mercado Pago)
   ===================================================================== */

// IDs de Pix fake aprovados após 15 s (só em modo teste)
const pixFakeAprovados = new Set();

// Cria um Pix e devolve o QR Code + copia-e-cola + id para acompanhar.
app.post('/api/pix', async (req, res) => {
  try {
    const { valor, descricao = 'Documento — Lan Blackout', email } = req.body || {};
    const total = Number(valor);
    if (!total || total <= 0) {
      return res.status(400).json({ erro: 'Valor inválido.' });
    }

    if (!mpPayment) {
      // Modo teste: devolve um Pix simulado e aprova automaticamente após 15 s
      const id = 'FAKE-' + randomUUID();
      setTimeout(() => pixFakeAprovados.add(id), 15_000);
      return res.json({
        id,
        status: 'pending',
        modo_teste: true,
        copia_e_cola: `00020126580014br.gov.bcb.pix0136${randomUUID()}5204000053039865802BR5925LAN BLACKOUT TESTE6009SAO PAULO62070503***6304FAKE`,
        qr_code_base64: '',
        link: ''
      });
    }

    const resultado = await mpPayment.create({
      body: {
        transaction_amount: Number(total.toFixed(2)),
        description: descricao,
        payment_method_id: 'pix',
        payer: { email: email || 'cliente@lanblackout.com.br' }
      },
      requestOptions: { idempotencyKey: randomUUID() }
    });

    const td = resultado?.point_of_interaction?.transaction_data || {};
    res.json({
      id: resultado.id,
      status: resultado.status,
      copia_e_cola: td.qr_code || '',
      qr_code_base64: td.qr_code_base64 || '',
      link: td.ticket_url || ''
    });
  } catch (err) {
    console.error('pix create:', err);
    res.status(502).json({ erro: 'Falha ao gerar o Pix.' });
  }
});

// Consulta o status de um Pix (o site fica perguntando até virar "approved").
app.get('/api/pix/:id', async (req, res) => {
  try {
    if (!mpPayment) {
      const aprovado = pixFakeAprovados.has(req.params.id);
      return res.json({ id: req.params.id, status: aprovado ? 'approved' : 'pending', modo_teste: true });
    }
    const resultado = await mpPayment.get({ id: req.params.id });
    res.json({ id: resultado.id, status: resultado.status });
  } catch (err) {
    console.error('pix status:', err);
    res.status(502).json({ erro: 'Falha ao consultar o Pix.' });
  }
});

// (Opcional) Webhook do Mercado Pago — útil para registrar pagamentos.
app.post('/api/webhook/mercadopago', (req, res) => {
  console.log('Webhook Mercado Pago:', JSON.stringify(req.body));
  res.sendStatus(200);
});

/* =====================================================================
   3) SOLICITAÇÃO DE DOCUMENTO JURÍDICO -> n8n (atendimento)
   ===================================================================== */
app.post('/api/solicitar', async (req, res) => {
  try {
    const { documento, valor, dados } = req.body || {};
    if (!documento || !dados) {
      return res.status(400).json({ erro: 'Dados incompletos.' });
    }

    if (process.env.N8N_WEBHOOK_URL) {
      try {
        await fetch(process.env.N8N_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documento, valor, dados, recebido_em: new Date().toISOString() })
        });
      } catch (e) {
        console.error('Falha ao enviar ao n8n:', e);
        // Não derruba a resposta: o site também abre o WhatsApp como garantia.
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('solicitar:', err);
    res.status(500).json({ erro: 'Erro ao enviar solicitação.' });
  }
});

/* =====================================================================
   4) UPLOAD DE PDF TEMPORÁRIO (Bez Clean — Orçamentos)
   ===================================================================== */
app.use('/pdfs', express.static(PDF_DIR));

app.post('/upload-pdf', express.json({ limit: '12mb' }), (req, res) => {
  try {
    const { base64, nome } = req.body || {};
    if (!base64) return res.status(400).json({ erro: 'base64 obrigatório' });

    const fileName = `${randomUUID()}.pdf`;
    const filePath = join(PDF_DIR, fileName);
    writeFileSync(filePath, Buffer.from(base64, 'base64'));

    // Auto-deletar após 4 horas
    setTimeout(() => { try { unlinkSync(filePath); } catch {} }, 4 * 60 * 60 * 1000);

    const baseUrl = process.env.PUBLIC_URL || 'https://blackout.ezstudio.com.br';
    res.json({ ok: true, url: `${baseUrl}/pdfs/${fileName}` });
  } catch (err) {
    console.error('upload-pdf:', err);
    res.status(500).json({ erro: 'Erro ao salvar PDF.' });
  }
});

/* ---- Sobe o servidor ---- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lan Blackout API rodando na porta ${PORT}`));
