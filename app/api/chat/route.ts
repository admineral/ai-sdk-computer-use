import { OpenAI, openai } from "@ai-sdk/openai";
import { UIMessage, streamUI } from "ai/rsc";
import { z } from "zod";
import { killDesktop } from "@/lib/e2b/utils";
import { computer_use_loop } from "@/lib/openai/tool";
import { bashTool, openaiComputerToolSchema } from "@/lib/e2b/tool"; // openaiComputerToolSchema provides the schema for the model
import { prunedMessages } from "@/lib/utils";

export const maxDuration = 60;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

export async function POST(req: Request) {
  const { messages, sandboxId }: { messages: UIMessage[]; sandboxId: string } =
    await req.json();
  try {
    const result = await streamUI({
      model: openai("gpt-4-turbo"), // Using a general model that can decide to call tools
      system:
        "You are a helpful assistant. You can use tools to execute bash commands or initiate a detailed computer interaction session. " +
        "If the user asks for something that requires browsing, complex UI interaction, or direct computer control, use the 'initiate_computer_session' tool. " +
        "For simple terminal commands, use the 'bash' tool. " +
        "The 'initiate_computer_session' tool takes a 'task' parameter which should be the user's detailed request for the computer interaction.",
      messages: prunedMessages(messages) as any,
      tools: {
        bash: bashTool(sandboxId),
        initiate_computer_session: openai.tools.defineTool({
          name: "initiate_computer_session",
          description:
            "Initiates a session for direct computer interaction to accomplish complex tasks using a browser environment. Use this for tasks involving web browsing, UI manipulation, or detailed computer control.",
          schema: z.object({
            task: z
              .string()
              .describe(
                "The detailed task or prompt for the computer interaction session.",
              ),
          }),
          execute: async ({ task }) => {
            console.log(
              `Initiating computer_use_loop for sandboxId: ${sandboxId} with task: "${task}"`,
            );
            try {
              const finalResponseFromLoop = await computer_use_loop(
                sandboxId,
                client, // The existing OpenAI client instance
                task, // The task description from the model
              );

              const assistantMessage =
                finalResponseFromLoop.choices[0]?.message;
              if (assistantMessage?.content) {
                // Return a summary or the final message from the loop
                return {
                  success: true,
                  summary: assistantMessage.content,
                  finalResponse: finalResponseFromLoop, // Optional: for debugging or further processing
                };
              } else if (assistantMessage?.tool_calls) {
                console.warn(
                  "computer_use_loop ended with tool_calls, returning as is.",
                );
                return {
                  success: false,
                  summary: "Computer session ended with pending tool calls.",
                  finalResponse: finalResponseFromLoop,
                };
              }
              return {
                success: true,
                summary: "Computer session completed.",
                finalResponse: finalResponseFromLoop,
              };
            } catch (loopError: any) {
              console.error("Error during computer_use_loop:", loopError);
              return {
                success: false,
                summary: "Error during computer session.",
                error: loopError.message,
              };
            }
          },
        }),
        // By including openaiComputerToolSchema here, we inform the model about the
        // computer_capabilities schema is not passed here as 'initiate_computer_session' is the explicit entry point.
      },
      // toolChoice: 'auto', // Let the model decide
    });
    return result.value;
  } catch (error: any) {
    console.error("Chat API error in POST:", error);
    if (sandboxId) {
      await killDesktop(sandboxId); // Force cleanup on error
    }
    // Ensure a Response object is always returned
    const errorMessage = error.message || "Internal Server Error";
    const errorStack = error.stack || "No stack trace available";
    return new Response(
      JSON.stringify({ error: errorMessage, details: errorStack }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
