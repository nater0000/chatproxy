// server.js

const express = require('express');
const { OpenAI } = require('openai');
const cors = require('cors');
const crypto = require('crypto'); // For generating unique session IDs
const app = express();

const port = process.env.PORT || 3010;
const openaiApiKey = process.env.OPENAI_API_KEY; // Make sure this is set in your environment
const openAiUrl = process.env.OPENAI_URL || null; // For custom OpenAI-compatible endpoints

// --- OpenAI Client Initialization ---
if (!openaiApiKey) {
  console.warn('Warning: OPENAI_API_KEY is not set. AI calls will likely fail.');
}
const openai = new OpenAI({
  apiKey: openaiApiKey,
  baseURL: openAiUrl,
});

// --- Application Configuration ---
const systemPrompt = "You are a helpful AI robot assistant C-3PO from a time long, long ago in a galaxy far, far away. Stay concise unless you are specifically requested to provide a long-winded explanation. Do not greet the user. You do not need to say goodbye or return to anything else. Focus on answering directly and be brief.";
const defaultModelName = "borch/llama3po:latest"; // Renamed to indicate it's a default
const keepAliveValue = "6000";

const temporaryChatSessions = new Map();
const SESSION_TTL_MS = 20 * 1000; // 20 seconds TTL for sessions

// --- CORS Configuration ---
const allowedOrigins = ['https://i.rickey.io', 'http://localhost', 'http://127.0.0.1']; //
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) { //
      callback(null, true);
    } else {
      console.log('Origin denied for CORS:', origin);
      callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'], //
  allowedHeaders: ['Content-Type', 'Authorization'], //
  credentials: true, //
  optionsSuccessStatus: 204, //
};

app.use(cors(corsOptions)); //

const bodyParserLimit = '50mb';
app.use(express.json({ limit: bodyParserLimit })); //

// --- Healthcheck Endpoint ---
app.get('/healthcheck', (req, res) => { //
  console.log('Node.js /healthcheck endpoint was hit!'); //
  res.status(200).send('OK from Node.js backend!'); //
});

// --- Reusable Core SSE Streaming Function ---
// Modified to accept an optional requestedModel parameter
async function streamOpenAiChat(res, messagesForOpenAI, endpointName = "chat", requestedModel = null) {
  const modelToUse = requestedModel || defaultModelName; // Use requested model or fallback to default
  console.log(`SSE stream initiated for ${endpointName}. Model: ${modelToUse}. Client messages: ${messagesForOpenAI.length -1}.`);

  res.setHeader('Content-Type', 'text/event-stream'); //
  res.setHeader('Cache-Control', 'no-cache'); //
  res.setHeader('Connection', 'keep-alive'); //
  res.flushHeaders(); //

  try {
    const stream = await openai.chat.completions.create({
      model: modelToUse, // Use the determined model
      messages: messagesForOpenAI, //
      keep_alive: keepAliveValue, //
      stream: true, //
    });

    for await (const chunk of stream) { //
      if (chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) { //
        const content = chunk.choices[0].delta.content; //
        res.write(`data: ${JSON.stringify({ token: content })}\n\n`); //
      }
      if (chunk.choices[0]?.finish_reason === 'stop') { //
        break;
      }
    }
    res.write(`data: ${JSON.stringify({ end: true })}\n\n`); //
  } catch (error) {
    console.error(`Error calling OpenAI API or during streaming for ${endpointName} (Model: ${modelToUse}):`, error.message);
    res.write(`data: ${JSON.stringify({ error: 'Failed to get response from AI', details: error.message })}\n\n`); //
  } finally {
    console.log(`SSE stream ended for ${endpointName} (Model: ${modelToUse})`);
    res.end(); //
  }
}

// --- New Two-Step Mechanism Endpoints ---

// 1. POST /api/prepare-stream: Accepts history and optional model, returns a session ID
app.post('/api/prepare-stream', (req, res) => {
  const conversationHistory = req.body.messages; //
  const requestedModel = req.body.model; // NEW: Get model from request body

  if (!conversationHistory || !Array.isArray(conversationHistory) || conversationHistory.length === 0) { //
    return res.status(400).json({ error: 'Valid message history (non-empty array) is required.' }); //
  }

  const sessionId = crypto.randomUUID(); //
  // Store history and the requested model (if any)
  temporaryChatSessions.set(sessionId, { history: conversationHistory, model: requestedModel }); //

  setTimeout(() => { //
    if (temporaryChatSessions.has(sessionId)) { //
      temporaryChatSessions.delete(sessionId); //
    }
  }, SESSION_TTL_MS); //

  res.json({ sessionId }); //
});

// 2. GET /api/chat-stream: Uses session ID to start SSE stream
app.get('/api/chat-stream', async (req, res) => {
  const { sessionId } = req.query; //

  if (!sessionId) { //
    return res.status(400).json({ error: 'Session ID is required.' }); //
  }

  const sessionData = temporaryChatSessions.get(sessionId); //

  if (!sessionData) { //
    return res.status(404).json({ error: 'Session not found or expired. Please try sending your message again.' }); //
  }

  temporaryChatSessions.delete(sessionId); //

  const clientMessages = sessionData.history;
  const requestedModelForSession = sessionData.model; // Get the model stored with the session

  const messagesForOpenAI = [ //
    //{ role: "system", content: systemPrompt }, 
    ...clientMessages,
  ];

  // Pass the session-specific model to the streaming function
  await streamOpenAiChat(res, messagesForOpenAI, "/api/chat-stream", requestedModelForSession); //
});

// --- Original Single-Step SSE Endpoint (Preserved with Model Override) ---
// GET /api/chat: Accepts full history and optional model in query param
app.get('/api/chat', async (req, res) => {
  const clientMessagesString = req.query.messages; //
  const requestedModel = req.query.model; // NEW: Get model from query parameters

  if (!clientMessagesString) { //
    return res.status(400).json({ error: 'Messages parameter is required for /api/chat.' }); //
  }

  let parsedClientMessages;
  try {
    parsedClientMessages = JSON.parse(clientMessagesString); //
    if (!Array.isArray(parsedClientMessages) || parsedClientMessages.length === 0) { //
      return res.status(400).json({ error: 'Messages parameter for /api/chat must be a non-empty JSON array string.' }); //
    }
  } catch (e) {
    return res.status(400).json({ error: 'Invalid messages format for /api/chat (must be a URL-encoded JSON array string).' }); //
  }

  const messagesForOpenAI = [ //
    { role: "system", content: systemPrompt }, //
    ...parsedClientMessages,
  ];

  // Pass the query model to the streaming function
  await streamOpenAiChat(res, messagesForOpenAI, "/api/chat (original)", requestedModel); //
});

// --- Start Server ---
app.listen(port, '0.0.0.0', () => { //
  console.log(`Chatbot backend server listening at http://localhost:${port} (and on 0.0.0.0)`); //
  console.log(`Supported chat endpoints:`); //
  console.log(`  POST /api/prepare-stream (Accepts body: { messages: [], model?: "model-name" })`);
  console.log(`  GET  /api/chat-stream?sessionId=<id> (Uses model from prepare-stream)`); //
  console.log(`  GET  /api/chat?messages=<json_array_string>&model=<model-name> (Original with optional model)`); //
});