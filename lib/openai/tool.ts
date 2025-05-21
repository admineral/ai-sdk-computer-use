import { OpenAI } from "@ai-sdk/openai";
import { Sandbox } from "@e2b/desktop"; // Assuming Sandbox is the correct type for desktop
import { Buffer } from "buffer";
import { resolution } from "../e2b/tool"; // For display_width, display_height
import { getDesktop } from "../e2b/utils"; // To get the desktop instance

// Helper to wait
const wait = async (milliseconds: number) => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

// 1. Define `handle_model_action`
async function handle_model_action(desktop: Sandbox, action: any): Promise<string | void> {
  console.log("Executing action:", JSON.stringify(action, null, 2));
  switch (action.type) {
    case "click":
      await desktop.moveMouse(action.x, action.y);
      if (action.button === "right") {
        await desktop.rightClick();
        return `Right clicked at ${action.x}, ${action.y}`;
      }
      await desktop.leftClick();
      return `Left clicked at ${action.x}, ${action.y}`;

    case "scroll":
      if (action.x !== undefined && action.y !== undefined) {
        await desktop.moveMouse(action.x, action.y);
      }
      // OpenAI uses scroll_x, scroll_y. E2B's scroll is 1D (up/down) and takes amount.
      // Prioritizing vertical scroll. Positive scroll_y for down, negative for up.
      if (action.scroll_y !== 0) {
        const direction = action.scroll_y > 0 ? "down" : "up";
        const amount = Math.abs(action.scroll_y);
        await desktop.scroll(direction, amount);
        return `Scrolled ${direction} by ${amount}px`;
      }
      // Horizontal scroll could be added if E2B supports it or via keypresses (e.g., Shift+Scroll or arrow keys)
      return "Scroll action noted (vertical scroll only implemented)";

    case "keypress":
      // Map common keys. E2B's `press` method takes specific key names.
      let keyToPress = action.key;
      if (action.key === "Enter") keyToPress = "enter";
      if (action.key === "Space") keyToPress = "space";
      // Add more mappings as needed
      await desktop.press(keyToPress);
      return `Pressed key: ${keyToPress}`;

    case "type":
      await desktop.write(action.text);
      return `Typed: ${action.text}`;

    case "wait":
      // OpenAI docs mention a 2-second sleep. Let's use the provided duration or default.
      const duration = action.duration_ms || 2000;
      await wait(duration);
      return `Waited for ${duration}ms`;

    case "screenshot":
      // We take a screenshot every turn in the loop, so this might be a no-op.
      console.log("Screenshot action received (handled by loop).");
      return "Screenshot action noted (handled by loop)";

    default:
      console.error("Unrecognized action type:", action.type);
      throw new Error(`Unrecognized action type: ${action.type}`);
  }
}

// 2. Define `get_screenshot`
async function get_screenshot(desktop: Sandbox): Promise<string> {
  const imageBytes = await desktop.screenshot();
  return Buffer.from(imageBytes).toString("base64");
}

// 3. Define `computer_use_loop`
export async function computer_use_loop(
  sandboxId: string,
  openAIClient: OpenAI,
  initialPrompt: string,
  // We might not need openAIClient passed if it's already available in the scope
  // where computer_use_loop is called, or if we instantiate it here.
  // For now, following the signature.
) {
  const desktop = await getDesktop(sandboxId);
  let safetyChecksToAcknowledge: any[] = []; // Store pending safety checks to acknowledge

  // Initial screenshot (optional, but good practice)
  const initialScreenshotBase64 = await get_screenshot(desktop);

  // Initial request to the model
  let currentResponse = await openAIClient.beta.chat.completions.runTools({
    model: "computer-use-preview",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: initialPrompt },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${initialScreenshotBase64}` },
          },
        ],
      },
    ],
    tools: [
      {
        type: "computer_use_preview",
        computer_use_preview: {
          display_width: resolution.x,
          display_height: resolution.y,
          environment: "browser",
        },
      },
    ],
    // @ts-expect-error - Tool choice seems to be an issue with the current SDK version or types
    tool_choice: { type: "computer_use_preview" }, // Explicitly ask for computer_use_preview
    truncation: "auto",
    reasoning: { summary: "concise" },
  });

  console.log("Initial response:", JSON.stringify(currentResponse, null, 2));

  // Interaction Loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const computerCalls = currentResponse.tool_calls?.filter(
      (call) => call.type === "computer_use_preview" && call.computer_use_preview?.actions?.length,
    );

    if (!computerCalls || computerCalls.length === 0) {
      console.log("No more computer actions or model decided to stop.");
      break;
    }

    // Assuming one computer_call with actions per response for simplicity,
    // though the API might support multiple.
    const computerCall = computerCalls[0].computer_use_preview;
    const callId = computerCalls[0].id; // This should be the ID of the tool_call, not the action

    if (!computerCall || !computerCall.actions) {
        console.log("No actions in computer call, breaking loop.");
        break;
    }
    
    // Process actions sequentially
    for (const action of computerCall.actions) {
        try {
            await handle_model_action(desktop, action);
        } catch (error) {
            console.error("Error executing action:", error);
            // Decide if/how to report this error back to the model
        }
    }

    await wait(1000); // Wait 1 second for changes to take effect on screen

    const screenshotBase64 = await get_screenshot(desktop);

    // Handle Safety Checks
    // The exact structure of pending_safety_checks needs to be verified from OpenAI's response object.
    // Assuming it's an array on the response or within the computer_call object.
    // Handle Safety Checks
    // Extract pending_safety_checks from the current computerCall, if any
    if (computerCall.pending_safety_checks && computerCall.pending_safety_checks.length > 0) {
      console.log("Received pending_safety_checks:", computerCall.pending_safety_checks);
      // Assuming the structure of pending_safety_checks is suitable for direct acknowledgement
      safetyChecksToAcknowledge = [...computerCall.pending_safety_checks];
    }

    // Construct the output for the current tool call
    const toolOutputContent: {
        type: string;
        image_url: string;
        current_url?: string;
        acknowledged_safety_checks?: any[];
    } = {
        type: "input_image", // This indicates the type of content we are sending
        image_url: `data:image/png;base64,${screenshotBase64}`,
        // current_url: "example.com" // Optional: current URL if available
    };

    if (safetyChecksToAcknowledge.length > 0) {
        toolOutputContent.acknowledged_safety_checks = safetyChecksToAcknowledge;
    }

    const toolOutputs = [
        {
            tool_call_id: callId,
            output: JSON.stringify(toolOutputContent),
        }
    ];
    
    // Clear the acknowledged checks after including them in the output
    if (safetyChecksToAcknowledge.length > 0) {
        console.log("Acknowledged safety checks in this turn:", JSON.stringify(safetyChecksToAcknowledge));
        safetyChecksToAcknowledge = []; 
    }
    
    console.log("Sending tool outputs:", JSON.stringify(toolOutputs, null, 2));

    // Prepare messages for the next call
    const history = currentResponse.messages; // Get all messages from the previous response
    
    
    // Construct the messages array for the next API call
    // It should include the history, the assistant's last response (with tool_calls), 
    // and the results of these tool_calls.
    const nextMessages: any[] = [
        ...history, // Messages from previous turns
        { // Assistant's response that included the tool_calls
            role: 'assistant',
            content: currentResponse.choices[0].message.content, // Can be null
            tool_calls: currentResponse.choices[0].message.tool_calls,
        },
        // Results for each tool call
        ...toolOutputs.map(toolOut => ({
            role: 'tool',
            tool_call_id: toolOut.tool_call_id,
            content: toolOut.output, // The stringified JSON output
        })),
    ];
    
    currentResponse = await openAIClient.beta.chat.completions.runTools({
        model: "computer-use-preview",
        messages: nextMessages,
        tools: [/* as above */
            {
                type: "computer_use_preview",
                computer_use_preview: {
                    display_width: resolution.x,
                    display_height: resolution.y,
                    environment: "browser",
                },
            },
        ],
        tool_choice: { type: "computer_use_preview" },
        tool_outputs, // This is where the results of the tool calls go
        // previous_response_id: previousResponseId, // This might be managed by the SDK or not needed with runTools
    });
    console.log("Next response:", JSON.stringify(currentResponse, null, 2));

    // Check for a condition to break the loop, e.g., if the model indicates completion
    // or if there are no more actions.
    if (currentResponse.choices[0]?.finish_reason === "stop" || currentResponse.choices[0]?.finish_reason === "tool_calls_done") {
        console.log("Model indicated completion.");
        break;
    }
  }

  console.log("Exiting computer_use_loop.");
  return currentResponse; // Return the final state or a summary
}
