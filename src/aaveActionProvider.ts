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

// AAVE V3 Pool ABI (expanded)
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
  },
  {
    name: 'repay',
    type: 'function',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'interestRateMode', type: 'uint256' },
      { name: 'onBehalfOf', type: 'address' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    name: 'withdraw',
    type: 'function',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'to', type: 'address' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    name: 'getUserAccountData',
    type: 'function',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [
      { name: 'totalCollateralBase', type: 'uint256' },
      { name: 'totalDebtBase', type: 'uint256' },
      { name: 'availableBorrowsBase', type: 'uint256' },
      { name: 'currentLiquidationThreshold', type: 'uint256' },
      { name: 'ltv', type: 'uint256' },
      { name: 'healthFactor', type: 'uint256' }
    ],
    stateMutability: 'view'
  }
] as const;

// WETH Gateway ABI
const WETH_GATEWAY_ABI = [
  "function depositETH(address pool, address onBehalfOf, uint16 referralCode) external payable",
  "function withdrawETH(address pool, uint256 amount, address to) external",
  "function repayETH(address pool, uint256 amount, uint256 rateMode, address onBehalfOf) external payable",
  "function borrowETH(address pool, uint256 amount, uint256 interestRateMode, uint16 referralCode) external"
];

function validateEnvironment(): void {
  const requiredVars = [
    "OPENAI_API_KEY",
    "CDP_API_KEY_NAME",
    "CDP_API_KEY_PRIVATE_KEY",
    "OPENAI_API_BASE",
    "USER_PRIVATE_KEY",
    "SEPOLIA_RPC_URL"
  ];
  
  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    console.error("Error: Required environment variables are not set:", missingVars.join(", "));
    process.exit(1);
  }
}

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

      const wethGateway = new ethers.Contract(
        AAVE_ADDRESSES.WETH_GATEWAY,
        WETH_GATEWAY_ABI,
        signer
      );

      console.log("Supplying ETH via WETHGateway...");
      const supplyTx = await wethGateway.depositETH(
        AAVE_ADDRESSES.POOL,
        await signer.getAddress(),
        0,
        {
          value: amount,
          gasLimit: 750000,
          maxFeePerGas: ethers.utils.parseUnits("150", "gwei"),
          maxPriorityFeePerGas: ethers.utils.parseUnits("8", "gwei")
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

const aaveBorrowAction = customActionProvider<EvmWalletProvider>({
  name: "aave_borrow",
  description: "Borrow ETH from AAVE using WETHGateway",
  schema: z.object({
    amount: z.string().describe("The amount to borrow in ETH"),
    interestRateMode: z.number().describe("Interest rate mode (1 for stable, 2 for variable)"),
  }),
  invoke: async (walletProvider, args) => {
    try {
      const amount = ethers.utils.parseEther(args.amount);
      const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
      const signer = new ethers.Wallet(process.env.USER_PRIVATE_KEY!, provider);
      
      // First check user account data
      const aavePool = new ethers.Contract(
        AAVE_ADDRESSES.POOL,
        AAVE_POOL_ABI,
        signer
      );
      
      const userData = await aavePool.getUserAccountData(await signer.getAddress());
      const availableToBorrow = ethers.utils.formatEther(userData.availableBorrowsBase);
      
      if (Number(args.amount) > Number(availableToBorrow)) {
        throw new Error(`Cannot borrow ${args.amount} ETH. Maximum available to borrow is ${availableToBorrow} ETH`);
      }

      const wethGateway = new ethers.Contract(
        AAVE_ADDRESSES.WETH_GATEWAY,
        WETH_GATEWAY_ABI,
        signer
      );

      console.log("Borrowing ETH via WETHGateway...");
      const borrowTx = await wethGateway.borrowETH(
        AAVE_ADDRESSES.POOL,
        amount,
        args.interestRateMode,
        0, // referral code
        {
          gasLimit: 750000,
          maxFeePerGas: ethers.utils.parseUnits("150", "gwei"),
          maxPriorityFeePerGas: ethers.utils.parseUnits("8", "gwei")
        }
      );
      
      console.log("Waiting for transaction confirmation...");
      const receipt = await borrowTx.wait();
      return `Successfully borrowed ${args.amount} ETH via WETHGateway. TX: ${receipt.transactionHash}`;

    } catch (error: any) {
      console.error("Borrow error details:", error);
      if (error.message.includes("availableBorrow")) {
        throw new Error(`Failed to borrow: Insufficient collateral. ${error.message}`);
      } else if (error.message.includes("health factor")) {
        throw new Error(`Failed to borrow: Would risk liquidation. ${error.message}`);
      } else {
        throw new Error(`Failed to borrow from AAVE: ${error.message}`);
      }
    }
  }
});

const aaveRepayAction = customActionProvider<ViemWalletProvider>({
  name: "aave_repay",
  description: "Repay borrowed assets to the AAVE lending pool",
  schema: z.object({
    asset: z.string().describe("The address of the asset to repay"),
    amount: z.string().describe("The amount to repay in wei"),
    interestRateMode: z.number().describe("Interest rate mode (1 for stable, 2 for variable)"),
  }),
  invoke: async (walletProvider, args) => {
    const client = walletProvider.client;
    const account = client.account;
    
    if (!account) throw new Error("No account configured");

    const hash = await client.writeContract({
      address: AAVE_ADDRESSES.POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'repay',
      args: [args.asset, BigInt(args.amount), BigInt(args.interestRateMode), account.address],
      gas: 750000n,
      maxFeePerGas: parseEther("0.00000015"),
      maxPriorityFeePerGas: parseEther("0.000000008")
    });

    const receipt = await client.waitForTransactionReceipt({ hash });
    return `Successfully repaid ${formatEther(BigInt(args.amount))} to AAVE pool. Transaction: ${receipt.transactionHash}`;
  }
});

const aaveWithdrawAction = customActionProvider<EvmWalletProvider>({
  name: "aave_withdraw",
  description: "Withdraw ETH from AAVE using WETHGateway",
  schema: z.object({
    amount: z.string().describe("The amount to withdraw in ETH"),
  }),
  invoke: async (walletProvider, args) => {
    try {
      const amount = ethers.utils.parseEther(args.amount);
      const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
      const signer = new ethers.Wallet(process.env.USER_PRIVATE_KEY!, provider);

      const wethGateway = new ethers.Contract(
        AAVE_ADDRESSES.WETH_GATEWAY,
        WETH_GATEWAY_ABI,
        signer
      );

      console.log("Withdrawing ETH via WETHGateway...");
      const withdrawTx = await wethGateway.withdrawETH(
        AAVE_ADDRESSES.POOL,
        amount,
        await signer.getAddress(),
        {
          gasLimit: 500000,
          maxFeePerGas: ethers.utils.parseUnits("50", "gwei"),
          maxPriorityFeePerGas: ethers.utils.parseUnits("2", "gwei")
        }
      );
      
      const receipt = await withdrawTx.wait();
      return `Successfully withdrew ${args.amount} ETH from AAVE via WETHGateway. TX: ${receipt.transactionHash}`;

    } catch (error: any) {
      console.error("Withdrawal error details:", error);
      throw new Error(`Failed to withdraw from AAVE: ${error.message}`);
    }
  }
});

const aaveGetUserDataAction = customActionProvider<EvmWalletProvider>({
  name: "aave_get_user_data",
  description: "Get user's AAVE account data including collateral, debt, and health factor",
  schema: z.object({
    userAddress: z.string().describe("The address of the user to query"),
  }),
  invoke: async (walletProvider, args) => {
    try {
      const provider = new ethers.providers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
      const signer = new ethers.Wallet(process.env.USER_PRIVATE_KEY!, provider);

      const aavePool = new ethers.Contract(
        AAVE_ADDRESSES.POOL,
        AAVE_POOL_ABI,
        signer
      );

      console.log(`Fetching AAVE data for address: ${args.userAddress}`);
      const userData = await aavePool.getUserAccountData(args.userAddress);

      const accountData = {
        totalCollateralBase: ethers.utils.formatEther(userData.totalCollateralBase),
        totalDebtBase: ethers.utils.formatEther(userData.totalDebtBase),
        availableBorrowsBase: ethers.utils.formatEther(userData.availableBorrowsBase),
        currentLiquidationThreshold: Number(userData.currentLiquidationThreshold) / 10000,
        ltv: Number(userData.ltv) / 10000,
        healthFactor: Number(userData.healthFactor) / 1e18
      };

      // Add risk assessment
      const riskStatus = accountData.healthFactor < 1 ? "HIGH RISK - LIQUIDATION IMMINENT" :
                        accountData.healthFactor < 1.5 ? "MEDIUM RISK" : "HEALTHY";

      return {
        ...accountData,
        riskStatus,
        timestamp: new Date().toISOString()
      };

    } catch (error: any) {
      console.error("Error fetching AAVE account data:", error);
      if (error.message.includes("execution reverted")) {
        throw new Error("Contract execution failed - the address may not be registered with AAVE");
      }
      throw new Error(`Failed to read AAVE account data: ${error.message}`);
    }
  }
});



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

    const account = privateKeyToAccount(`0x${process.env.USER_PRIVATE_KEY}`);
    
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
        aaveBorrowAction,
        aaveRepayAction,
        aaveWithdrawAction,
        aaveGetUserDataAction
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