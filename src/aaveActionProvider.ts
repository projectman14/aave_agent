//@ts-nocheck
import {
  AgentKit,
  ViemWalletProvider,
  walletActionProvider,
  customActionProvider,
  CdpWalletProvider,
  wethActionProvider,
  erc20ActionProvider,
  cdpApiActionProvider,
  cdpWalletActionProvider,
  pythActionProvider,
  EvmWalletProvider,
} from "@coinbase/agentkit";
import { getLangChainTools } from "@coinbase/agentkit-langchain";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as readline from "readline";
import { z } from "zod";
import { createWalletClient, http, parseEther, formatEther } from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ethers } from "ethers";

dotenv.config();

// AAVE V3 Sepolia Contract Addresses
const AAVE_ADDRESSES = {
  POOL: "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951",
  POOL_ADDRESSES_PROVIDER: "0x0496275d34753A48320CA58103d5220d394FF77F",
  WETH_GATEWAY: "0x387d311e47e80b498169e6fb51d3193167d89F7D",
  WETH: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
  DAI: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357",
  USDC: "0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8"
};

// AAVE V3 Pool ABI (simplified for Viem)
const AAVE_POOL_ABI = [
  {
    name: 'supply',
    type: 'function',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' },
      { name: 'referralCode', type: 'uint16' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    name: 'borrow',
    type: 'function',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'referralCode', type: 'uint16' },
      { name: 'onBehalfOf', type: 'address' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  }
] as const;

function validateEnvironment(): void {
  const requiredVars = [
    "OPENAI_API_KEY",
    "CDP_API_KEY_NAME",
    "CDP_API_KEY_PRIVATE_KEY",
    "OPENAI_API_BASE",
    "USER_PRIVATE_KEY",
    "SEPOLIA_RPC_URL"  // Added Sepolia RPC URL requirement
  ];
  
  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error("Error: Required environment variables are not set:", missingVars.join(", "));
    process.exit(1);
  }
}

const WETH_GATEWAY_ABI = [
  "function depositETH(address pool, address onBehalfOf, uint16 referralCode) external payable",
  "function withdrawETH(address pool, uint256 amount, address to) external",
  "function repayETH(address pool, uint256 amount, uint256 rateMode, address onBehalfOf) external payable",
  "function borrowETH(address pool, uint256 amount, uint256 interestRateMode, uint16 referralCode) external"
];

const aaveSupplyAction = customActionProvider<EvmWalletProvider>({
  name: "aave_supply",
  description: "Supply ETH to AAVE using WETHGateway",
  schema: z.object({
    amount: z.string().describe("The amount to supply in ETH"),
  }),
  invoke: async (walletProvider, args) => {
    try {
      const amount = ethers.utils.parseEther(args.amount);
      const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
      const signer = new ethers.Wallet(process.env.USER_PRIVATE_KEY!, provider);

      // Use WETHGateway contract
      const wethGateway = new ethers.Contract(
        AAVE_ADDRESSES.WETH_GATEWAY,
        WETH_GATEWAY_ABI,
        signer
      );

      console.log("Supplying ETH via WETHGateway...");
      const supplyTx = await wethGateway.depositETH(
        "0x387d311e47e80b498169e6fb51d3193167d89F7D",
        await signer.getAddress(),
        0, // referral code
        {
          value: amount,
          gasLimit: 500000,
          // Increased gas fees for faster processing
          maxFeePerGas: ethers.utils.parseUnits("100", "gwei"),        // Doubled from 50 to 100 gwei
          maxPriorityFeePerGas: ethers.utils.parseUnits("5", "gwei")   // Increased from 2 to 5 gwei
        }
      );
      
      const receipt = await supplyTx.wait();
      return `Successfully supplied ${args.amount} ETH to AAVE via WETHGateway. TX: ${receipt.transactionHash}`;

    } catch (error: any) {
      console.error("Supply error details:", error);
      throw new Error(`Failed to supply to AAVE: ${error.message}`);
    }
  }
});




const aaveBorrowAction = customActionProvider<ViemWalletProvider>({
  name: "aave_borrow",
  description: "Borrow assets from the AAVE lending pool",
  schema: z.object({
    asset: z.string().describe("The address of the asset to borrow"),
    amount: z.string().describe("The amount to borrow in wei"),
    interestRateMode: z.number().describe("Interest rate mode (1 for stable, 2 for variable)"),
  }),
  invoke: async (walletProvider, args) => {
    const client = walletProvider.client;
    const account = client.account;
    
    if (!account) throw new Error("No account configured");

    const hash = await client.writeContract({
      address: AAVE_ADDRESSES.POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'borrow',
      args: [args.asset, BigInt(args.amount), BigInt(args.interestRateMode), 0, account.address]
    });

    const receipt = await client.waitForTransactionReceipt({ hash });
    
    return `Successfully borrowed ${formatEther(BigInt(args.amount))} from AAVE pool. Transaction: ${receipt.transactionHash}`;
  }
});

// Initialize agent with AAVE capabilities
async function initializeAgent() {
  try {
    const llm = new ChatOpenAI({
      model: "gpt-4o-mini",
      temperature: 0.7,
      maxTokens: 500,
    });

    if (!process.env.USER_PRIVATE_KEY) {
      throw new Error("USER_PRIVATE_KEY not found in environment variables");
    }

    const account = privateKeyToAccount('0x58eb1aa66eee85f81f4708ba72e9927519c668e702ba586e40c8fe45ef7018c9');
    
    const client = createWalletClient({
      account,
      chain: sepolia,
      transport: http(process.env.SEPOLIA_RPC_URL)
    });

    const walletProvider = new ViemWalletProvider(client);

    const agentkit = await AgentKit.from({
      walletProvider,
      actionProviders: [
        wethActionProvider(),
        pythActionProvider(),
        walletActionProvider(),
        erc20ActionProvider(),
        cdpApiActionProvider({
          apiKeyName: process.env.CDP_API_KEY_NAME,
          apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
        cdpWalletActionProvider({
          apiKeyName: process.env.CDP_API_KEY_NAME,
          apiKeyPrivateKey: process.env.CDP_API_KEY_PRIVATE_KEY?.replace(/\\n/g, "\n"),
        }),
        aaveSupplyAction,
        aaveBorrowAction
      ],
    });

    const tools = await getLangChainTools(agentkit);
    const memory = new MemorySaver();
    
    const agentConfig = {
      configurable: { thread_id: "CDP AgentKit AAVE Chatbot" },
    };

    const agent = createReactAgent({
      llm,
      tools,
      checkpointSaver: memory,
      messageModifier: `
        You are a helpful agent that can interact with the AAVE protocol using Coinbase Developer Platform AgentKit.
        You can perform actions like supplying assets to and borrowing from AAVE pools. Before executing your first
        action, get the wallet details to see what network you're on. If there is a 5XX error, ask the user to try
        again later. If someone asks you to do something you can't do with your available tools, recommend they
        implement it using the CDP SDK + Agentkit (docs.cdp.coinbase.com). Be concise and helpful.
      `,
    });

    return { agent, config: agentConfig };
  } catch (error) {
    console.error("Failed to initialize agent:", error);
    throw error;
  }
}

// Rest of the code remains the same as in the original script
async function runAutonomousMode(agent: any, config: any, interval = 10) {
  console.log("Starting autonomous mode...");

  while (true) {
    try {
      const thought =
        "Monitor AAVE pools and suggest optimal lending/borrowing strategies. " +
        "Execute actions that maximize yield while managing risk.";

      const stream = await agent.stream(
        { messages: [new HumanMessage(thought)] },
        config,
      );

      for await (const chunk of stream) {
        if ("agent" in chunk) {
          console.log(chunk.agent.messages[0].content);
        } else if ("tools" in chunk) {
          console.log(chunk.tools.messages[0].content);
        }
        console.log("-------------------");
      }

      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    } catch (error) {
      if (error instanceof Error) {
        console.error("Error:", error.message);
      }
      process.exit(1);
    }
  }
}

async function runChatMode(agent: any, config: any) {
  console.log("Starting chat mode... Type 'exit' to end.");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  try {
    while (true) {
      const userInput = await question("\nPrompt: ");

      if (userInput.toLowerCase() === "exit") {
        break;
      }

      const stream = await agent.stream(
        { messages: [new HumanMessage(userInput)] },
        config,
      );

      for await (const chunk of stream) {
        if ("agent" in chunk) {
          console.log(chunk.agent.messages[0].content);
        } else if ("tools" in chunk) {
          console.log(chunk.tools.messages[0].content);
        }
        console.log("-------------------");
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error:", error.message);
    }
    process.exit(1);
  } finally {
    rl.close();
  }
}

async function chooseMode(): Promise<"chat" | "auto"> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    console.log("\nAvailable modes:");
    console.log("1. chat    - Interactive chat mode");
    console.log("2. auto    - Autonomous action mode");

    const choice = (await question("\nChoose a mode (enter number or name): "))
      .toLowerCase()
      .trim();

    if (choice === "1" || choice === "chat") {
      rl.close();
      return "chat";
    } else if (choice === "2" || choice === "auto") {
      rl.close();
      return "auto";
    }
    console.log("Invalid choice. Please try again.");
  }
}

async function main() {
  try {
    validateEnvironment();
    const { agent, config } = await initializeAgent();
    const mode = await chooseMode();

    if (mode === "chat") {
      await runChatMode(agent, config);
    } else {
      await runAutonomousMode(agent, config);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error("Error:", error.message);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  console.log("Starting AAVE-enabled Agent...");
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}