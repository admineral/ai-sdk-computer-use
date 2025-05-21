import { OpenAI, openai } from "@ai-sdk/openai";
import { z } from "zod";
import { getDesktop } from "./utils";
// computer_use_loop is not directly executed by this tool definition,
// but this file defines the tool schema that signals its availability.
// The loop is invoked in route.ts.
// import { computer_use_loop } from "../openai/tool";

export const resolution = { x: 1024, y: 768 };

// This function defines the schema for the 'computer_use_preview' tool
// that the OpenAI model expects. It doesn't have an 'execute' method here
// because the actual interaction loop ('computer_use_loop') is initiated
// from the route handler based on the model's request to use this tool.
export const openaiComputerToolSchema = () => {
  return {
    type: "computer_use_preview" as const,
    computer_use_preview: {
      // Parameters for the tool, display_width, display_height, environment
      // are part of the top-level structure for this specific tool type.
      // No explicit parameters needed here in the schema for the model to fill,
      // as the interaction starts with the user prompt and an initial screenshot.
      // The `computer_use_loop` handles these.
      display_width: resolution.x,
      display_height: resolution.y,
      environment: "browser" as const,
    },
  };
};

// Define the bash tool using defineTool for a clear schema
export const bashTool = (sandboxId?: string) =>
  openai.tools.defineTool({
    name: "bash",
    description:
      "Execute a bash command in a sandbox environment. Returns stdout and stderr.",
    schema: z.object({
      command: z.string().describe("The bash command to execute."),
    }),
    execute: async ({ command }) => {
      const desktop = await getDesktop(sandboxId);
      try {
        const result = await desktop.commands.run(command);
        // Combine stdout and stderr for a comprehensive output
        let output = "";
        if (result.stdout) output += `Stdout:\n${result.stdout}\n`;
        if (result.stderr) output += `Stderr:\n${result.stderr}\n`;
        if (!output) {
          output = "(Command executed successfully with no output)";
        }
        return output;
      } catch (error: any) {
        console.error("Bash command failed:", error);
        return `Error executing command: ${error.message || String(error)}`;
      }
    },
  });
