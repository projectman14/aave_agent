//@ts-nocheck
import express from 'express';
import cors from 'cors';
import { main, runChatMode } from './src/chatbot';

const app = express();
const PORT = process.env.PORT || 3000;

let agent, config;

// Initialize the agent and config
(async () => {
  try {
    const result = await main();
    agent = result.agent;
    config = result.config;
  } catch (error) {
    console.error('Failed to initialize:', error);
  }
})();

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Parse JSON bodies

// Post request route
app.post('/api/data', async (req, res) => {
  try {
    const data =await req.body.message;
    let obj = await runChatMode(agent, config , data);

    res.status(200).json({
      success: true,
      message: 'Data received successfully',
      data: obj
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Error processing request',
      error: error?.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});