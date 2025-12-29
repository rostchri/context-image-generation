/**
 * Context Image Generation 🍌
 * Gemini-powered image generation with avatar references and character context
 * Uses SillyTavern's backend to handle Google AI authentication
 */

import { 
    saveSettingsDebounced, 
    getRequestHeaders, 
    appendMediaToMessage, 
    eventSource, 
    event_types, 
    saveChatConditional,
    user_avatar,
    getUserAvatar as getAvatarPath,
    name1,
} from '../../../../script.js';

import { getContext, extension_settings } from '../../../extensions.js';
import { getBase64Async } from '../../../utils.js';
import { power_user } from '../../../power-user.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE, SCROLL_BEHAVIOR } from '../../../constants.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const extensionName = 'context-image-generation';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// important for custom openai
const CUSTOM_URL = 'http://100.77.172.64:8000/v1';

// Toggle this to enable/disable debug logs
const VISUALS_JSON_DEBUG = true;

const defaultSettings = {
    model: 'gemini-2.5-flash-image',
    aspect_ratio: '1:1',
    image_size: '',
    use_avatars: false,
    include_descriptions: false,
    system_instruction: 'You are an image generation assistant. When reference images are provided, they represent the characters in the story. Generate an illustration that depicts the scene described in the prompt while maintaining the art style and appearance of the reference characters. You are not obligated to include both characters - if the scene depicts only one character alone, illustrate them alone.',
    gallery: [],
};

const MAX_GALLERY_SIZE = 50;

function vdbg(...args) {
  if (!VISUALS_JSON_DEBUG) return;
  console.log('[context-image-generation][visuals-json]', ...args);
}

vdbg('debug logging ENABLED');

async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }

    $('#cig_model').val(extension_settings[extensionName].model);
    $('#cig_aspect_ratio').val(extension_settings[extensionName].aspect_ratio);
    $('#cig_image_size').val(extension_settings[extensionName].image_size);
    $('#cig_use_avatars').prop('checked', extension_settings[extensionName].use_avatars);
    $('#cig_include_descriptions').prop('checked', extension_settings[extensionName].include_descriptions);
    $('#cig_system_instruction').val(extension_settings[extensionName].system_instruction);

    toggleImageSizeVisibility();
    renderGallery();
}

function toggleImageSizeVisibility() {
    const model = extension_settings[extensionName].model;
    const isProModel = /gemini-3-pro/.test(model);
    $('#cig_image_size_container').toggle(isProModel);
}

async function getUserAvatar() {
    try {
        let avatarUrl = getAvatarPath(user_avatar);
        if (!avatarUrl) return null;

        const response = await fetch(avatarUrl);
        if (!response.ok) return null;

        const blob = await response.blob();
        const base64 = await getBase64Async(blob);
        const parts = base64.split(',');
        const mimeType = parts[0]?.match(/data:([^;]+)/)?.[1] || 'image/png';
        const data = parts[1] || base64;
        const userName = name1 || 'User';

        return { mimeType, data, role: 'user', name: userName };
    } catch (error) {
        console.warn(`[${extensionName}] Error fetching user avatar:`, error);
        return null;
    }
}

async function getCharacterAvatar() {
    const context = getContext();
    const character = context.characters[context.characterId];
    if (!character?.avatar) return null;

    try {
        const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
        const response = await fetch(avatarUrl);
        if (!response.ok) return null;

        const blob = await response.blob();
        const base64 = await getBase64Async(blob);
        const parts = base64.split(',');
        const mimeType = parts[0]?.match(/data:([^;]+)/)?.[1] || 'image/png';

        return {
            mimeType,
            data: parts[1] || base64,
            role: 'character',
            name: context.name2 || 'Character',
        };
    } catch (error) {
        console.warn(`[${extensionName}] Error fetching character avatar:`, error);
        return null;
    }
}

function getLastMessage() {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return { text: '', isUser: false };

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message.mes && !message.is_system) {
            return { text: message.mes, isUser: message.is_user };
        }
    }
    return { text: '', isUser: false };
}

function getCharacterDescriptions() {
    const context = getContext();
    const character = context.characters[context.characterId];
    const userName = name1 || context.name1 || 'User';

    return {
        user_name: userName,
        user_persona: power_user.persona_description || '',
        char_name: context.name2 || 'Character',
        char_description: character?.description || '',
        char_scenario: character?.scenario || '',
    };
}

/**
 * Build messages array for the API request
 * @param {string} prompt - The prompt text
 * @param {string|null} sender - Optional sender: '{{user}}', '{{char}}', or null for slash commands
 */
async function buildMessages(prompt, sender = null) {
    const settings = extension_settings[extensionName];
    const messages = [];
    const contentParts = [];

    if (settings.system_instruction) {
        contentParts.push({ type: 'text', text: settings.system_instruction });
    }

    if (settings.include_descriptions) {
        const descriptions = getCharacterDescriptions();
        let descText = '';
        if (descriptions.user_persona) {
            descText += `[${descriptions.user_name} (User) Description]: ${descriptions.user_persona}\n\n`;
        }
        if (descriptions.char_description) {
            descText += `[${descriptions.char_name} (Character) Description]: ${descriptions.char_description}\n\n`;
        }
        if (descriptions.char_scenario) {
            descText += `[Current Scenario]: ${descriptions.char_scenario}\n\n`;
        }
        if (descText) {
            contentParts.push({ type: 'text', text: descText.trim() });
        }
    }

    // Add prompt with sender context if available
    if (sender) {
        contentParts.push({ type: 'text', text: `[Message from ${sender}]: ${prompt}` });
    } else {
        contentParts.push({ type: 'text', text: prompt });
    }

    if (settings.use_avatars) {
        const userAvatarData = await getUserAvatar();
        const charAvatarData = await getCharacterAvatar();

        if (charAvatarData) {
            console.log(`[${extensionName}] Adding character avatar for: ${charAvatarData.name}`);
            contentParts.push({ type: 'text', text: `[Reference image for {{char}}]` });
            contentParts.push({
                type: 'image_url',
                image_url: { url: `data:${charAvatarData.mimeType};base64,${charAvatarData.data}` },
            });
        }

        if (userAvatarData) {
            console.log(`[${extensionName}] Adding user avatar for: ${userAvatarData.name}`);
            contentParts.push({ type: 'text', text: `[Reference image for {{user}}]` });
            contentParts.push({
                type: 'image_url',
                image_url: { url: `data:${userAvatarData.mimeType};base64,${userAvatarData.data}` },
            });
        }
    }

    messages.push({ role: 'user', content: contentParts });
    return messages;
}

/**
 * Extracts a JSON object from a fenced block of the form:
 *
 * ```json
 * { ... }
 * ```
 *
 * Requirements:
 * - The opening fence ``` must be at the start of a line
 * - "json" must be on the same line as the opening fence
 * - The JSON must start with "{" on the next line (allowing whitespace)
 * - The extracted JSON must be syntactically valid (JSON.parse)
 * - (optional) contains key "perspective"
 *
 * Returns:
 * - the JSON string "{...}" if found and valid
 * - null otherwise
 */
function extractVisualsJsonBlock(text) {
  if (typeof text !== 'string' || !text.trim()) {
    vdbg('input not a non-empty string');
    return null;
  }

  // Multiline + global:
  // Opening fence at line start: ^```json\s*$
  // Captures a JSON object starting with { ... } then closing fence at line start.
  const fenceRe = /^```json\s*$\s*^(\{[\s\S]*?\})\s*$\s*^```[ \t]*$/gmi;

  const matches = [...text.matchAll(fenceRe)];
  vdbg(`found ${matches.length} fenced \`\`\`json blocks`);

  if (!matches.length) return null;

  // helper for safe previews
  const preview = (s, n = 200) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  // Pick the last valid JSON block (usually the most recent)
  for (let i = matches.length - 1; i >= 0; i--) {
    const candidate = (matches[i][1] || '').trim();

    vdbg(`checking candidate #${i}:`, preview(candidate));

    if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
      vdbg(`candidate #${i} rejected: does not start/end with braces`);
      continue;
    }

    try {
      const obj = JSON.parse(candidate);

      if (!obj || typeof obj !== 'object') {
        vdbg(`candidate #${i} rejected: JSON parsed but not an object`);
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(obj, 'perspective')) {
        vdbg(`candidate #${i} rejected: missing "perspective" key`);
        continue;
      }

      vdbg(`candidate #${i} accepted ✅ perspective=`, obj.perspective);
      return candidate;
    } catch (e) {
      vdbg(`candidate #${i} rejected: JSON.parse failed`, e);
      continue;
    }
  }

  vdbg('no valid visuals JSON block found');
  return null;
}

/** Optional: apply extraction or fall back to original prompt */
function maybeUseVisualsJson(prompt) {
  const extracted = extractVisualsJsonBlock(prompt);
  if (extracted) {
    vdbg('using extracted visuals JSON as prompt (replacing original)');
    return extracted;
  }
  vdbg('no visuals JSON extracted; using original prompt');
  return prompt;
  //const json = extractVisualsJsonBlock(prompt);
  //return json || prompt;
}

/**
 * Core generation function
 * @param {string} prompt - The prompt
 * @param {string|null} sender - Optional sender context
 */
async function generateImageFromPrompt(prompt, sender = null) {
    const settings = extension_settings[extensionName];

    vdbg('generateImageFromPrompt called. sender=', sender);
    vdbg('prompt preview:', String(prompt ?? '').slice(0, 200));
    const filteredPrompt = maybeUseVisualsJson(prompt);
    const messages = await buildMessages(filteredPrompt, sender);

    const requestBody = {
        chat_completion_source: 'custom',
        model: settings.model,
        messages: messages,
        max_tokens: 8192,
        temperature: 1,
        request_images: true,
        request_image_aspect_ratio: settings.aspect_ratio || '1:1',
        request_image_resolution: settings.image_size || undefined,
        stream: false,
        // important for custom openai
        custom_url: CUSTOM_URL,
        custom_model_id: settings.model,
    };

    console.log(`[${extensionName}] Generating image with model:`, settings.model);

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[${extensionName}] API Error Response:`, errorText);
        let errorMessage = `API Error: ${response.status}`;
        try {
            const errorJson = JSON.parse(errorText);
            errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
        } catch (e) {}
        throw new Error(errorMessage);
    }

    const result = await response.json();
    const responseContent = result.responseContent;
    
    if (responseContent?.parts) {
        for (const part of responseContent.parts) {
            if (part.inlineData?.data) {
                const mimeType = part.inlineData.mimeType || 'image/png';
                return { imageData: part.inlineData.data, mimeType: mimeType };
            }
        }
    }

    const textContent = result.choices?.[0]?.message?.content;
    if (textContent) {
        console.log(`[${extensionName}] Text response received:`, textContent);
        throw new Error('Model returned text instead of image');
    }

    throw new Error('No image was returned by the API');
}

function addToGallery(imageData, prompt, messageId = null) {
    const settings = extension_settings[extensionName];
    
    if (!settings.gallery) {
        settings.gallery = [];
    }

    settings.gallery.unshift({
        imageData: imageData,
        prompt: prompt.substring(0, 200),
        timestamp: Date.now(),
        messageId: messageId,
    });

    if (settings.gallery.length > MAX_GALLERY_SIZE) {
        settings.gallery = settings.gallery.slice(0, MAX_GALLERY_SIZE);
    }

    saveSettingsDebounced();
    renderGallery();
}

function renderGallery() {
    const settings = extension_settings[extensionName];
    const gallery = settings.gallery || [];
    const container = $('#cig_gallery_container');
    const emptyMsg = $('#cig_gallery_empty');

    container.empty();

    if (gallery.length === 0) {
        emptyMsg.show();
        return;
    }

    emptyMsg.hide();

    for (let i = 0; i < gallery.length; i++) {
        const item = gallery[i];
        const thumb = $(`
            <div class="cig_gallery_item" data-index="${i}" title="${item.prompt}">
                <img src="data:image/png;base64,${item.imageData}" />
                <div class="cig_gallery_item_overlay">
                    <i class="fa-solid fa-trash cig_gallery_delete" data-index="${i}"></i>
                </div>
            </div>
        `);
        container.append(thumb);
    }
}

async function generateImage() {
    const lastMsg = getLastMessage();
    if (!lastMsg.text) {
        toastr.warning('No message found to generate image from.', 'Context Image Generation');
        return;
    }

    const generateBtn = $('#cig_generate_btn');
    generateBtn.addClass('generating');
    generateBtn.find('i').removeClass('fa-image').addClass('fa-spinner fa-spin');

    // Determine sender
    const charName = getContext().name2 || 'Character'; const userName = name1 || 'User'; const sender = lastMsg.isUser ? `{{user}} (${userName})` : `{{char}} (${charName})`;

    try {
        const result = await generateImageFromPrompt(lastMsg.text, sender);
        
        if (result) {
            const imageDataUrl = `data:${result.mimeType};base64,${result.imageData}`;
            $('#cig_preview_image').attr('src', imageDataUrl);
            $('#cig_preview_container').show();
            addToGallery(result.imageData, lastMsg.text, null);
        }

    } catch (error) {
        console.error(`[${extensionName}] Generation error:`, error);
        toastr.error(`Failed to generate image: ${error.message}`, 'Context Image Generation');
    } finally {
        generateBtn.removeClass('generating');
        generateBtn.find('i').removeClass('fa-spinner fa-spin').addClass('fa-image');
    }
}

async function cigMessageButton($icon) {
    const context = getContext();
    
    if ($icon.hasClass('cig_busy')) {
        console.log('[CIG] Already generating...');
        return;
    }

    const messageElement = $icon.closest('.mes');
    const messageId = Number(messageElement.attr('mesid'));
    const message = context.chat[messageId];

    if (!message) {
        console.error('[CIG] Could not find message for generation button');
        return;
    }

    const prompt = message.mes;
    if (!prompt) {
        toastr.warning('No message content to generate from.', 'Context Image Generation');
        return;
    }

    // Determine sender from message
    const charName = getContext().name2 || 'Character'; const userName = name1 || 'User'; const sender = message.is_user ? `{{user}} (${userName})` : `{{char}} (${charName})`;

    $icon.addClass('cig_busy');
    $icon.removeClass('fa-wand-magic-sparkles').addClass('fa-spinner fa-spin');

    try {
        const result = await generateImageFromPrompt(prompt, sender);

        if (result) {
            const imageDataUrl = `data:${result.mimeType};base64,${result.imageData}`;

            if (!message.extra || typeof message.extra !== 'object') {
                message.extra = {};
            }

            if (!Array.isArray(message.extra.media)) {
                message.extra.media = [];
            }

            if (!message.extra.media_display) {
                message.extra.media_display = MEDIA_DISPLAY.GALLERY;
            }

            const mediaAttachment = {
                url: imageDataUrl,
                type: MEDIA_TYPE.IMAGE,
                title: prompt.substring(0, 100),
                source: MEDIA_SOURCE.GENERATED,
            };

            message.extra.media.push(mediaAttachment);
            message.extra.media_index = message.extra.media.length - 1;
            message.extra.inline_image = true;

            appendMediaToMessage(message, messageElement, SCROLL_BEHAVIOR.KEEP);
            await saveChatConditional();
            addToGallery(result.imageData, prompt, messageId);
        }

    } catch (error) {
        console.error(`[${extensionName}] Message generation error:`, error);
        toastr.error(`Failed to generate: ${error.message}`, 'Context Image Generation');
    } finally {
        $icon.removeClass('cig_busy fa-spinner fa-spin').addClass('fa-wand-magic-sparkles');
    }
}

async function slashCommandHandler(args, prompt) {
    const trimmedPrompt = String(prompt).trim();
    
    if (!trimmedPrompt) {
        toastr.warning('Please provide a prompt for image generation.', 'Context Image Generation');
        return '';
    }

    try {
        // No sender for slash commands - it's a direct prompt
        const result = await generateImageFromPrompt(trimmedPrompt, null);
        
        if (result) {
            const imageDataUrl = `data:${result.mimeType};base64,${result.imageData}`;
            $('#cig_preview_image').attr('src', imageDataUrl);
            $('#cig_preview_container').show();
            addToGallery(result.imageData, trimmedPrompt, null);
            return imageDataUrl;
        }
    } catch (error) {
        console.error(`[${extensionName}] Slash command generation error:`, error);
        toastr.error(`Failed to generate: ${error.message}`, 'Context Image Generation');
    }
    
    return '';
}

function injectMessageButton(messageId) {
    const messageElement = $(`.mes[mesid="${messageId}"]`);
    if (messageElement.length === 0) return;
    
    const extraButtons = messageElement.find('.extraMesButtons');
    if (extraButtons.length === 0) return;

    if (extraButtons.find('.cig_message_gen').length > 0) return;

    const cigButton = $(`
        <div title="Generate with Gemini 🍌" 
             class="mes_button cig_message_gen fa-solid fa-wand-magic-sparkles" 
             data-i18n="[title]Generate with Gemini 🍌">
        </div>
    `);

    const sdButton = extraButtons.find('.sd_message_gen');
    if (sdButton.length) {
        sdButton.after(cigButton);
    } else {
        extraButtons.prepend(cigButton);
    }
}

function injectAllMessageButtons() {
    $('.mes').each(function() {
        const messageId = $(this).attr('mesid');
        if (messageId !== undefined) {
            injectMessageButton(Number(messageId));
        }
    });
}

async function clearGallery() {
    if (!confirm('Are you sure you want to clear the gallery? This cannot be undone.')) {
        return;
    }

    extension_settings[extensionName].gallery = [];
    saveSettingsDebounced();
    renderGallery();
    toastr.info('Gallery cleared.', 'Context Image Generation');
}

function viewGalleryImage(index) {
    const settings = extension_settings[extensionName];
    const item = settings.gallery[index];
    if (!item) return;

    const imageUrl = `data:image/png;base64,${item.imageData}`;
    
    const popup = $(`
        <div class="cig_popup_overlay">
            <div class="cig_popup">
                <div class="cig_popup_header">
                    <span>${new Date(item.timestamp).toLocaleString()}</span>
                    <i class="fa-solid fa-xmark cig_popup_close"></i>
                </div>
                <img src="${imageUrl}" />
                <div class="cig_popup_prompt">${item.prompt}</div>
            </div>
        </div>
    `);

    popup.on('click', '.cig_popup_close, .cig_popup_overlay', function(e) {
        if (e.target === this || $(e.target).hasClass('cig_popup_close')) {
            popup.remove();
        }
    });

    $('body').append(popup);
}

function deleteGalleryImage(index) {
    const settings = extension_settings[extensionName];
    settings.gallery.splice(index, 1);
    saveSettingsDebounced();
    renderGallery();
}

jQuery(async () => {
    console.log(`[${extensionName}] Initializing extension...`);
    
    try {
        const response = await fetch(`/scripts/extensions/third-party/${extensionName}/settings.html`);
        if (!response.ok) throw new Error(`Failed to load template: ${response.status}`);
        const settingsHtml = await response.text();
        $('#extensions_settings').append(settingsHtml);
    } catch (error) {
        console.error(`[${extensionName}] Error loading settings template:`, error);
        toastr.error('Failed to load extension settings.', 'Context Image Generation');
        return;
    }

    await loadSettings();

    $('#cig_model').on('change', function () {
        extension_settings[extensionName].model = $(this).val();
        toggleImageSizeVisibility();
        saveSettingsDebounced();
    });

    $('#cig_aspect_ratio').on('change', function () {
        extension_settings[extensionName].aspect_ratio = $(this).val();
        saveSettingsDebounced();
    });

    $('#cig_image_size').on('change', function () {
        extension_settings[extensionName].image_size = $(this).val();
        saveSettingsDebounced();
    });

    $('#cig_use_avatars').on('change', function () {
        extension_settings[extensionName].use_avatars = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cig_include_descriptions').on('change', function () {
        extension_settings[extensionName].include_descriptions = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#cig_system_instruction').on('input', function () {
        extension_settings[extensionName].system_instruction = $(this).val();
        saveSettingsDebounced();
    });

    $('#cig_generate_btn').on('click', generateImage);
    $('#cig_clear_gallery').on('click', clearGallery);

    $(document).on('click', '.cig_gallery_item img', function() {
        const index = $(this).closest('.cig_gallery_item').data('index');
        viewGalleryImage(index);
    });

    $(document).on('click', '.cig_gallery_delete', function(e) {
        e.stopPropagation();
        const index = $(this).data('index');
        deleteGalleryImage(index);
    });

    $(document).on('click', '.cig_message_gen', function(e) {
        cigMessageButton($(e.currentTarget));
    });

    eventSource.on(event_types.MESSAGE_RENDERED, (messageId) => {
        injectMessageButton(messageId);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(injectAllMessageButtons, 100);
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        setTimeout(injectAllMessageButtons, 100);
    });

    eventSource.on(event_types.CHAT_CREATED, () => {
        setTimeout(injectAllMessageButtons, 100);
    });

    setTimeout(injectAllMessageButtons, 500);

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'proimagine',
        returns: 'URL of the generated image, or an empty string if generation failed',
        callback: slashCommandHandler,
        aliases: ['proimg', 'geminiimg'],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Prompt for image generation',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Generate an image using Gemini Pro image generation. Example: /proimagine a beautiful sunset over mountains',
    }));

    console.log(`[${extensionName}] Extension loaded successfully!`);
});
