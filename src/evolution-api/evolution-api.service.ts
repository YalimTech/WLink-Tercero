// src/evolution-api/evolution-api.service.ts
import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  BaseAdapter,
  NotFoundError,
  IntegrationError,
} from '../core/base-adapter';
import { EvolutionApiTransformer, getMessageBody } from './evolution-api.transformer';
import { PrismaService } from '../prisma/prisma.service';
import { EvolutionService } from '../evolution/evolution.service';
import { GhlWebhookDto } from './dto/ghl-webhook.dto';
import {
  User,
  Instance,
  GhlPlatformMessage,
  EvolutionWebhook,
  GhlContact,
  MessageStatusPayload,
  InstanceState,
} from '../types';

@Injectable()
export class EvolutionApiService extends BaseAdapter<
  GhlPlatformMessage,
  EvolutionWebhook,
  User,
  Instance
> {
  private readonly ghlApiBaseUrl = 'https://services.leadconnectorhq.com';
  private readonly ghlApiVersion = '2021-07-28';

  private isValidGhlUserId(possibleId: any, locationId?: string): boolean {
    if (!possibleId || typeof possibleId !== 'string') return false;
    if (locationId && possibleId === locationId) return false;
    return /^[A-Za-z0-9]{15,}$/.test(possibleId);
  }

  constructor(
    protected readonly evolutionApiTransformer: EvolutionApiTransformer,
    protected readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly evolutionService: EvolutionService,
    logger: Logger,
  ) {
    super(evolutionApiTransformer, prisma, logger);
  }

  private async getHttpClient(ghlLocationId: string): Promise<AxiosInstance> {
    const userWithTokens = await this.prisma.getUserWithTokens(ghlLocationId);
    if (!userWithTokens?.accessToken || !userWithTokens?.refreshToken) {
      this.logger.error(
        `No tokens found for GHL User (Location ID): ${ghlLocationId}`,
      );
      throw new HttpException(
        `GHL auth tokens not found. Please re-authorize the application.`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    let currentAccessToken = userWithTokens.accessToken;
    const willExpireSoon =
      userWithTokens.tokenExpiresAt &&
      new Date(userWithTokens.tokenExpiresAt).getTime() <
        Date.now() + 5 * 60 * 1000;

    if (willExpireSoon) {
      this.logger.log(
        `Access token for User ${ghlLocationId} is expiring. Refreshing...`,
      );
      try {
        const newTokens = await this.refreshGhlAccessToken(
          userWithTokens.refreshToken,
        );
        await this.prisma.updateUserTokens(
          ghlLocationId,
          newTokens.access_token,
          newTokens.refresh_token,
          new Date(Date.now() + newTokens.expires_in * 1000),
        );
        currentAccessToken = newTokens.access_token;
      } catch (err) {
        throw new HttpException(
          `Unable to refresh GHL token. Please re-authorize.`,
          HttpStatus.UNAUTHORIZED,
        );
      }
    }

    return axios.create({
      baseURL: this.ghlApiBaseUrl,
      headers: {
        Authorization: `Bearer ${currentAccessToken}`,
        Version: this.ghlApiVersion,
        'Content-Type': 'application/json',
      },
    });
  }

  private async refreshGhlAccessToken(refreshToken: string): Promise<any> {
    const body = new URLSearchParams({
      client_id: this.configService.get('GHL_CLIENT_ID')!,
      client_secret: this.configService.get('GHL_CLIENT_SECRET')!,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      user_type: 'Location',
    });
    const response = await axios.post(
      `${this.ghlApiBaseUrl}/oauth/token`,
      body,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );
    return response.data;
  }

  public async getGhlUserDetails(locationId: string, ghlLocationId: string): Promise<any | null> {
    try {
      const httpClient = await this.getHttpClient(locationId);
      const response = await httpClient.get(`/users/${ghlLocationId}`);
      this.logger.log(`Fetched GHL user details for ${ghlLocationId}: ${JSON.stringify(response.data)}`);
      return response.data?.user || response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        this.logger.warn(`GHL User ${ghlLocationId} not found for location ${locationId}.`);
        return null;
      }
      this.logger.error(`Error fetching GHL user details for ${ghlLocationId}: ${error.message}`, error.stack);
      throw new IntegrationError(`Failed to fetch GHL user details: ${error.message}`);
    }
  }

  public async getGhlContactByPhone(
    locationId: string,
    phone: string,
  ): Promise<GhlContact | null> {
    const httpClient = await this.getHttpClient(locationId);
    const digits = this.normalizeDigits(phone);
    if (!digits) return null;

    const formattedPhone = this.normalizePhoneE164(phone);
    try {
      this.logger.log(`Attempting lookup for contact in GHL with phone: ${formattedPhone}`);
      const { data } = await httpClient.get(`/contacts/lookup`, {
        params: { phone: formattedPhone, locationId },
      });
      const contact = data?.contacts?.[0];
      if (contact) {
        this.logger.log(`Contact found via lookup with ID: ${contact.id}`);
        return contact;
      }
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      if (status === 404 || status === 400) {
        this.logger.warn(`Lookup for phone ${formattedPhone} failed with status ${status}. This can be normal for new contacts. Trying search as a fallback.`);
      } else {
        this.logger.error(
          `Error during contact lookup in GHL. Status: ${status}, Data: ${JSON.stringify(axiosError.response?.data)}`,
        );
      }
    }

    try {
      this.logger.log(`Attempting search for contact in GHL with query: ${digits}`);
      // ✅ FIX: Changed endpoint from `/contacts/search` to `/contacts`
      const { data } = await httpClient.get(`/contacts`, {
        params: { locationId, query: digits },
      });
      const list: any[] = (data?.contacts || []) as any[];
      if (Array.isArray(list) && list.length > 0) {
        const match = list.find((c: any) => {
          const p = this.normalizeDigits(c?.phone || c?.phoneNumber || '');
          return p.endsWith(digits) || digits.endsWith(p);
        });
        if (match) {
          this.logger.log(`Contact found via search with ID: ${match.id}`);
          return match as GhlContact;
        }
      }
    } catch (error: any) {
      const s = (error as AxiosError).response?.status;
      const d = (error as AxiosError).response?.data;
      this.logger.error(`Contact search failed entirely. Status: ${s} ${JSON.stringify(d)}`);
    }

    this.logger.log(`No contact found for phone ${formattedPhone} after trying lookup and search.`);
    return null;
  }
  
  public async getGhlContactById(
    locationId: string,
    contactId: string,
  ): Promise<GhlContact | null> {
    const httpClient = await this.getHttpClient(locationId);
    try {
      const { data } = await httpClient.get(`/contacts/${contactId}`);
      return (data?.contact || data) as GhlContact;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 404) {
        this.logger.warn(`Contact ${contactId} not found for location ${locationId}.`);
        return null;
      }
      this.logger.error(
        `Error fetching contact by id in GHL. Status: ${axiosError.response?.status}, Data: ${JSON.stringify(axiosError.response?.data)}`,
      );
      throw error;
    }
  }

  private async findOrCreateGhlConversation(
    locationId: string,
    contactId: string,
  ): Promise<any | null> {
    const http = await this.getHttpClient(locationId);
    try {
      const { data } = await http.get('/conversations/search', {
        params: { locationId, contactId },
      });
      const list: any[] = (data?.conversations || data?.data || data) as any[];
      if (Array.isArray(list) && list.length > 0) {
        this.logger.log(`Conversación encontrada para el contacto ${contactId}`);
        return list[0];
      }
    } catch (err: any) {
      const status = err?.response?.status;
      const msg = err?.response?.data ? JSON.stringify(err.response.data) : err?.message;
      this.logger.debug(`[findOrCreateGhlConversation] GET /conversations/search failed: ${status} ${msg}`);
    }

    const createPayload = { locationId, contactId };
    for (const url of ['/conversations/', '/conversations', '/conversations/create']) {
      try {
        const { data } = await http.post(url, createPayload);
        this.logger.log(`Conversación creada para el contacto ${contactId}`);
        return (data?.conversation || data);
      } catch (err: any) {
        const status = err?.response?.status;
        const msg = err?.response?.data ? JSON.stringify(err.response.data) : err?.message;
        this.logger.debug(`[findOrCreateGhlConversation] POST ${url} failed: ${status} ${msg}`);
      }
    }
    this.logger.error('Error creating conversation in GHL for contact ' + contactId + ' at location ' + locationId);
    return null;
  }

  
  private async postInboundMessage(
    locationId: string,
    conversationId: string,
    contactId: string,
    body: string,
    direction: 'inbound' | 'outbound',
    type: 'SMS' | 'Email',
    userId?: string,
): Promise<any> {
    const http = await this.getHttpClient(locationId);

    const conversationProviderId = this.configService.get<string>(
        'GHL_CONVERSATION_PROVIDER_ID',
    );

    const messageTypeForGhl =
        conversationProviderId && type === 'SMS' ? 'Custom' : type;

    // ✨ CORRECCIÓN FINAL: Unificamos los payloads y el endpoint
    
    // El payload base es muy similar para ambos casos
    const payload: any = {
        type: messageTypeForGhl,
        conversationId,
        contactId,
        message: body, // Usamos 'message' consistentemente
        direction,
        conversationProviderId,
    };
    
    // Añadimos propiedades específicas según la dirección
    if (direction === 'inbound') {
        payload.status = 'unread';
    } else if (direction === 'outbound') {
        // Para mensajes salientes, es crucial incluir el userId del agente
        payload.userId = userId;
    }

    try {
        // ENVIAMOS TODO A TRAVÉS DEL ENDPOINT '/inbound'
        // Este endpoint ha demostrado manejar correctamente el type: 'Custom' para ambas direcciones.
        const { data } = await http.post(
            `/conversations/messages/inbound`,
            payload,
            { headers: { Version: '2021-07-28' } },
        );
        this.logger.log(`Mensaje (${direction}) procesado exitosamente para la conversación ${conversationId}`);
        return data;
    } catch (error: any) {
        this.logger.error(`Error enviando mensaje (${direction}) a GHL a través de /inbound:`, error?.response?.data);
        throw new IntegrationError(`Failed to post ${direction} message to GHL.`);
    }
}

  
  private normalizePhoneE164(phone: string): string {
    if (!phone) return '';
    const digits = phone.replace(/[^0-9]/g, '');
    return phone.startsWith('+') ? phone : `+${digits}`;
  }

  private normalizeDigits(phone: string): string {
    return (phone || '').replace(/[^0-9]/g, '');
  }

  private async listGhlUsers(locationId: string): Promise<any[]> {
    const httpClient = await this.getHttpClient(locationId);
    const attempts: Array<{ url: string; params?: any }> = [
      { url: '/users/', params: { locationId } },
      { url: '/users', params: { locationId } },
    ];
    for (const attempt of attempts) {
      try {
        const { data } = await httpClient.get(attempt.url, { params: attempt.params });
        const list = (data?.users || data?.data || data) as any[];
        if (Array.isArray(list)) {
          this.logger.debug(`[listGhlUsers] Got ${list.length} users from ${attempt.url}`);
          return list;
        }
      } catch (err: any) {
        const status = err?.response?.status;
        const msg = err?.response?.data ? JSON.stringify(err.response.data) : (err?.message || 'unknown');
        this.logger.debug(`[listGhlUsers] Attempt ${attempt.url} failed with status ${status}. Data: ${msg}`);
      }
    }
    return [];
  }

  public async findGhlUserByPhone(locationId: string, phone: string): Promise<any | null> {
    try {
      const users = await this.listGhlUsers(locationId);
      if (!users || users.length === 0) return null;
      const normalizedPhone = (phone || '').replace(/\D/g, '');
      if (!normalizedPhone) return null;
      const found = users.find((u: any) => {
        const userDigits = (u?.phone || '').replace(/\D/g, '');
        if (!userDigits) return false;
        return userDigits.endsWith(normalizedPhone) || normalizedPhone.endsWith(userDigits);
      });
      if (found?.id) {
        this.logger.log(`[EvolutionApiService] Found GHL user by phone. phone=${normalizedPhone}, userId=${found.id}, name=${found.firstName || ''} ${found.lastName || ''}`);
      } else {
        this.logger.warn(`[EvolutionApiService] No matching GHL user found by phone ${normalizedPhone} in location ${locationId}.`);
      }
      return found || null;
    } catch (error: any) {
      this.logger.error('[EvolutionApiService] Error searching GHL user by phone:', error?.response?.data || error?.message);
      return null;
    }
  }

  private async tryMapAgentUserByPhone(instance: Instance & { user: User }, agentPhoneDigits: string): Promise<string | undefined> {
    if (!agentPhoneDigits) return undefined;
    try {
      const users = await this.listGhlUsers(instance.locationId);
      for (const u of users) {
        const phoneDigits = this.normalizeDigits(u?.phone || '');
        if (phoneDigits && phoneDigits.endsWith(agentPhoneDigits)) {
          const agentUserId = u?.id as string | undefined;
          if (this.isValidGhlUserId(agentUserId, instance.locationId)) {
            const newSettings = { ...(instance.settings || {}), agentUserId, agentPhone: agentPhoneDigits };
            await this.prisma.updateInstanceSettings(instance.instanceName, newSettings as any);
            this.logger.log(`[EvolutionApiService] Mapped agent userId '${agentUserId}' by phone '${agentPhoneDigits}' for instance '${instance.instanceName}'.`);
            return agentUserId;
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`[EvolutionApiService] Could not map agent by phone for instance '${instance.instanceName}': ${err?.message || err}`);
    }
    return undefined;
  }

  private async sendWhatsAppMessageWithRetry(
    instanceToken: string,
    instanceName: string,
    toPhone: string,
    text: string,
  ): Promise<void> {
    const digits = this.normalizeDigits(toPhone);
    try {
      await this.evolutionService.sendMessage(instanceToken, instanceName, digits, text);
      return;
    } catch (err: any) {
      const status = err?.response?.status;
      try {
        const e164 = this.normalizePhoneE164(toPhone);
        await this.evolutionService.sendMessage(instanceToken, instanceName, e164, text);
        return;
      } catch (err2: any) {
        this.logger.error(`Error sending message via Evolution API (digits=${digits} / e164=${this.normalizePhoneE164(toPhone)}): ${status || ''} ${err2?.response?.status || ''}`);
        throw new IntegrationError('Failed to send message via Evolution API');
      }
    }
  }

  /**
   * ✅ NEW: Creates a new contact in GHL using the /contacts endpoint.
   */
  private async createGhlContact(
    locationId: string,
    phone: string,
    name: string,
    avatarUrl?: string,
  ): Promise<GhlContact> {
    this.logger.log(
      `Attempting to create new GHL contact for phone: ${phone} with name: "${name}"`,
    );
    try {
      const httpClient = await this.getHttpClient(locationId);
      const payload: any = {
        locationId,
        phone: this.normalizePhoneE164(phone),
        name,
        source: 'WhatsApp WLink',
      };
      if (avatarUrl) {
        payload.avatarUrl = avatarUrl;
      }
      // Uses POST /contacts/ which is for creation, safer than upsert
      const { data } = await httpClient.post('/contacts/', payload);
      if (data?.contact?.id) {
        this.logger.log(
          `Contact created successfully with ID: ${data.contact.id}`,
        );
        return data.contact as GhlContact;
      }
      this.logger.error(
        'The GHL /contacts response did not contain a contact ID.',
        data,
      );
      throw new Error('Invalid response from GHL when creating contact.');
    } catch (error: any) {
      this.logger.error(
        'Critical error creating contact in GHL:',
        error.response?.data,
      );
      throw new Error('Could not create contact in GHL.');
    }
  }

  /**
   * ✅ NEW: Updates an existing GHL contact using the /contacts/{id} endpoint.
   */
  private async updateGhlContact(
    locationId: string,
    contactId: string,
    payload: { name?: string; avatarUrl?: string },
  ): Promise<GhlContact> {
    this.logger.log(`Attempting to update GHL contact ${contactId} with payload: ${JSON.stringify(payload)}`);
    try {
      const httpClient = await this.getHttpClient(locationId);
      const { data } = await httpClient.put(`/contacts/${contactId}`, payload);
      if (data?.contact?.id) {
        this.logger.log(`Contact ${contactId} updated successfully.`);
        return data.contact as GhlContact;
      }
      this.logger.error(`The GHL PUT /contacts/${contactId} response was invalid.`, data);
      throw new Error('Invalid response from GHL when updating contact.');
    } catch (error: any) {
      this.logger.error(
        `Critical error updating contact ${contactId} in GHL:`,
        error.response?.data,
      );
      throw new Error(`Could not update contact ${contactId} in GHL.`);
    }
  }

  public async handlePlatformWebhook(
    ghlWebhook: GhlWebhookDto,
    instanceName: string,
  ): Promise<void> {
    const instance = await this.prisma.getInstance(instanceName);
    if (!instance) throw new NotFoundError(`Instance ${instanceName} not found`);
    if (instance.state !== 'authorized')
      throw new IntegrationError(`Instance ${instanceName} is not authorized`);

    await this.sendWhatsAppMessageWithRetry(
      instance.apiTokenInstance,
      instance.instanceName,
      ghlWebhook.phone,
      ghlWebhook.message,
    );
    await this.updateGhlMessageStatus(
      ghlWebhook.locationId,
      ghlWebhook.messageId,
      'delivered',
    );
  }

  public async handleEvolutionWebhook(webhook: EvolutionWebhook): Promise<void> {
    const instanceName = webhook.instance;
    if (!instanceName) {
      this.logger.warn('[EvolutionApiService] Webhook received without an instance name. Ignoring.');
      return;
    }

    this.logger.log(
      `[EvolutionApiService] Processing webhook for instance: '${instanceName}', Event: '${webhook.event}'.`,
    );
    this.logger.debug(`[EvolutionApiService] Full Webhook Payload: ${JSON.stringify(webhook)}`);

    if (webhook.event === 'connection.update' && typeof webhook.data?.state !== 'undefined') {
      const state = webhook.data.state;
      let mappedStatus: InstanceState;

      switch (state) {
        case 'open': mappedStatus = 'authorized'; break;
        case 'connecting': mappedStatus = 'starting'; break;
        case 'close': mappedStatus = 'notAuthorized'; break;
        case 'qrcode': mappedStatus = 'qr_code'; break;
        default:
          this.logger.warn(`[EvolutionApiService] Unknown connection state received for '${instanceName}': '${state}'. Not updating state.`);
          return;
      }
      
      this.logger.log(`[EvolutionApiService] Attempting to update instance '${instanceName}' state from webhook. Mapped Status: '${mappedStatus}'`);
      const updated = await this.prisma.updateInstanceState(instanceName, mappedStatus);
      
      if (updated) { 
        this.logger.log(`[EvolutionApiService] Instance '${instanceName}' state updated to '${mappedStatus}' via webhook.`);
        const wuid: string | undefined = (webhook.data as any)?.wuid;
        const profilePic: string | undefined = (webhook.data as any)?.profilePictureUrl;
        const digits = wuid ? this.normalizeDigits(wuid) : undefined;
        let needUpdateSettings = false;
        const newSettings: any = { ...(updated.settings || {}) };
        if (digits) {
          newSettings.agentPhone = digits;
          needUpdateSettings = true;
          await this.tryMapAgentUserByPhone(updated as any, digits);
        }
        if (profilePic) {
          newSettings.agentAvatarUrl = profilePic;
          needUpdateSettings = true;
        }
        if (needUpdateSettings) {
          try {
            await this.prisma.updateInstanceSettings(instanceName, newSettings);
          } catch {}
        }
      } else {
        this.logger.warn(`[EvolutionApiService] Webhook for instance '${instanceName}' received, but could not find/update it in DB. Check instance name.`);
      }
    } else if ((webhook.event === 'messages.upsert' || webhook.event === 'MESSAGES_UPSERT') && webhook.data?.key?.remoteJid) {
        let instance = await this.prisma.getInstance(instanceName);
        if (!instance) {
          const possibleInstanceId: string | undefined = webhook?.data?.instanceId;
          if (possibleInstanceId) {
            try {
              const byId = await this.prisma.findInstanceById(possibleInstanceId);
              if (byId) {
                instance = byId;
                this.logger.log(`[EvolutionApiService] Resolved instance by instanceId '${possibleInstanceId}' for webhook instance '${instanceName}'.`);
              }
            } catch {}
          }
        }
        if (!instance) {
          this.logger.warn(`[EvolutionApiService] Webhook 'messages.upsert' for unknown instance '${instanceName}'. Ignoring message.`);
          return;
        }

        const { data } = webhook;
        const contactPhone = data.key.remoteJid.split('@')[0];
        const isFromAgent = data.key?.fromMe === true;

        let ghlContact: GhlContact | null = await this.getGhlContactByPhone(instance.locationId, contactPhone);

        // ✅ REVISED LOGIC
        if (isFromAgent) {
            if (!ghlContact) {
                const genericName = `WhatsApp User ${contactPhone.slice(-4)}`;
                this.logger.log(`[EvolutionApiService] Outbound message to a new number. Creating contact for ${contactPhone} with generic name.`);
                ghlContact = await this.createGhlContact(instance.locationId, contactPhone, genericName);
            }
        } else { // Incoming message
            const senderName = data.pushName || `WhatsApp User ${contactPhone.slice(-4)}`;
            const profilePictureUrl = await this.evolutionService.getProfilePic(instance.apiTokenInstance, instance.instanceName, data.key.remoteJid) || undefined;
            
            if (ghlContact) {
                // Contact exists. Only update avatar if it's new.
                this.logger.log(`Found existing GHL contact '${ghlContact.name || 'N/A'}' (ID: ${ghlContact.id}). Name will not be changed.`);
                const updatePayload: { avatarUrl?: string } = {};
                
                if (profilePictureUrl) {
                    updatePayload.avatarUrl = profilePictureUrl;
                }

                if (Object.keys(updatePayload).length > 0) {
                    ghlContact = await this.updateGhlContact(instance.locationId, ghlContact.id, updatePayload);
                }
            } else {
                // Contact does not exist. Create it with the sender's name and avatar.
                this.logger.log(`[EvolutionApiService] No GHL contact found for ${contactPhone}. Creating new contact with name '${senderName}'.`);
                ghlContact = await this.createGhlContact(instance.locationId, contactPhone, senderName, profilePictureUrl);
            }
        }

        if (!ghlContact) {
            this.logger.error(`[EvolutionApiService] Failed to find or create a GHL contact for phone ${contactPhone}. Aborting message processing.`);
            return;
        }
        
        const direction: 'inbound' | 'outbound' = isFromAgent ? 'outbound' : 'inbound';
        const messageBody = getMessageBody(webhook.data.message);
        if (!messageBody) {
          this.logger.warn(`[EvolutionApiService] Empty or unsupported message body for instance ${instanceName}. Ignoring.`);
          return;
        }

        const conversation = await this.findOrCreateGhlConversation(instance.locationId, ghlContact.id);
        if (!conversation) {
          this.logger.error(`[EvolutionApiService] Could not find or create conversation for contact ${ghlContact.id}`);
          return;
        }
        const conversationId: string = (conversation?.id || (conversation as any)?.conversationId || (conversation as any)?.conversation?.id);

        let agentUserId: string | undefined = undefined;
        if (isFromAgent) {
          try {
            const senderJid: string | undefined = (webhook as any)?.sender;
            let agentDigits = '';
            if (senderJid) agentDigits = this.normalizeDigits(senderJid.split('@')[0]);
            if (!agentDigits && (instance.settings as any)?.agentPhone) {
              agentDigits = this.normalizeDigits((instance.settings as any)?.agentPhone);
            }
            if (agentDigits) {
              const ghlUser = await this.findGhlUserByPhone(instance.locationId, agentDigits);
              if (ghlUser?.id && this.isValidGhlUserId(ghlUser.id, instance.locationId)) {
                agentUserId = ghlUser.id;
                this.logger.log(`[EvolutionApiService] Outbound message attributed to agent ${ghlUser.firstName || ''} ${ghlUser.lastName || ''} (ID: ${ghlUser.id}).`);
                try {
                  const newSettings = { ...(instance.settings || {}) } as any;
                  newSettings.agentUserId = ghlUser.id;
                  newSettings.agentPhone = agentDigits;
                  await this.prisma.updateInstanceSettings(instance.instanceName, newSettings);
                } catch {}
              }
            }
            if (!agentUserId) {
              const mapped = (instance.settings as any)?.agentUserId as string | undefined;
              if (this.isValidGhlUserId(mapped, instance.locationId)) {
                agentUserId = mapped;
                this.logger.log(`[EvolutionApiService] Using previously mapped agentUserId from settings for instance '${instance.instanceName}'.`);
              } else {
                this.logger.warn('[EvolutionApiService] Could not resolve agent userId for outbound message; sending without user attribution.');
              }
            }
          } catch {}
        }

        await this.postInboundMessage(
          instance.locationId,
          conversationId,
          ghlContact.id,
          messageBody,
          direction,
          'SMS',
          agentUserId,
        );
        this.logger.log(`[EvolutionApiService] Message upsert processed for instance '${instanceName}'.`);
    } else {
      this.logger.log(`[EvolutionApiService] Evolution Webhook event '${webhook.event}' received for instance '${instanceName}'. No specific handler or missing data. Full Payload: ${JSON.stringify(webhook)}`);
    }
  }

  public async createEvolutionApiInstanceForUser(
    locationId: string,
    evolutionApiInstanceName: string,
    apiToken: string,
    customName?: string,
    providedInstanceId?: string,
  ): Promise<Instance> {
    this.logger.log(`[EvolutionApiService] Attempting to create instance: '${evolutionApiInstanceName}' (Custom: '${customName}') for location: '${locationId}'`);
    
    const existing = await this.prisma.getInstance(evolutionApiInstanceName);
    if (existing && existing.locationId === locationId) {
      this.logger.warn(`[EvolutionApiService] Instance '${evolutionApiInstanceName}' already exists for this location.`);
      throw new HttpException(
        `An instance with ID '${evolutionApiInstanceName}' already exists for your WLink account.`,
        HttpStatus.CONFLICT,
      );
    }

    try {
      this.logger.log(`[EvolutionApiService] Validating credentials for Evolution API Instance Name: '${evolutionApiInstanceName}'...`);
      const isValid = await this.evolutionService.validateInstanceCredentials(
        apiToken,
        evolutionApiInstanceName,
      );
      if (!isValid) {
        this.logger.error(`[EvolutionApiService] Invalid credentials for Evolution API Instance Name: '${evolutionApiInstanceName}'.`);
        throw new HttpException(
          'Invalid credentials provided for Evolution API Instance Name and Token.',
          HttpStatus.BAD_REQUEST,
        );
      }
      this.logger.log(`[EvolutionApiService] Credentials valid for '${evolutionApiInstanceName}'. Fetching initial status...`);

      const statusInfo = await this.evolutionService.getInstanceStatus(
        apiToken,
        evolutionApiInstanceName,
      );
      
      const state = statusInfo?.instance?.state || 'close';
      const mappedState: InstanceState =
        state === 'open'
          ? 'authorized'
          : state === 'connecting'
          ? 'starting'
          : state === 'qrcode'
          ? 'qr_code'
          : 'notAuthorized';
      
      this.logger.log(`[EvolutionApiService] Initial status for '${evolutionApiInstanceName}' from Evolution API: '${state}'. Mapped to: '${mappedState}'`);

      const newInstance = await this.prisma.createInstance({
        instanceName: evolutionApiInstanceName,
        instanceId: providedInstanceId || statusInfo?.instance?.instanceId || null,
        apiTokenInstance: apiToken,
        user: { connect: { locationId: locationId } },
        customName: customName || `Instance ${evolutionApiInstanceName}`,
        state: mappedState,
        settings: {},
      });
      this.logger.log(`[EvolutionApiService] Instance '${evolutionApiInstanceName}' created in DB with initial state: '${mappedState}'.`);

      try {
        const appUrl = this.configService.get<string>('APP_URL');
        if (!appUrl) {
          this.logger.warn('[EvolutionApiService] APP_URL not configured; skipping webhook setup.');
        } else {
          const webhookUrl = `${appUrl.replace(/\/$/, '')}/webhooks/evolution`;
          const payload = {
            webhook: {
              url: webhookUrl,
              headers: {
                Authorization: `Bearer ${apiToken}`,
              },
              events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
              enabled: true,
            },
          } as any;
          await this.evolutionService.setWebhook(apiToken, evolutionApiInstanceName, payload);
          this.logger.log(`[EvolutionApiService] Webhook set for instance '${evolutionApiInstanceName}' -> ${webhookUrl}`);
        }
      } catch (whErr: any) {
        this.logger.error(`[EvolutionApiService] Failed to set webhook for instance '${evolutionApiInstanceName}': ${whErr.message}`);
      }
      return newInstance;
    } catch (error) {
      this.logger.error(
        `[EvolutionApiService] Failed to verify or create instance '${evolutionApiInstanceName}': ${error.message}. Stack: ${error.stack}`,
      );
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        'Failed to verify Evolution API credentials or create instance.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  public async updateGhlMessageStatus(
    locationId: string,
    messageId: string,
    status: 'delivered' | 'read' | 'failed' | 'sent',
    meta: Partial<MessageStatusPayload> = {},
  ): Promise<void> {
    this.logger.log(
      `Updating message ${messageId} status to ${status} for location ${locationId}`,
    );
    const http = await this.getHttpClient(locationId);
    const conversationProviderId = this.configService.get<string>('GHL_CONVERSATION_PROVIDER_ID');
    if (!conversationProviderId) {
      this.logger.warn('[updateGhlMessageStatus] GHL_CONVERSATION_PROVIDER_ID not configured. Skipping status update to avoid 403.');
      return;
    }
    try {
      await http.put(`/conversations/messages/${encodeURIComponent(messageId)}/status`, {
        status,
        conversationProviderId: meta.conversationProviderId || conversationProviderId,
        providerId: meta.providerId || conversationProviderId,
        ...meta,
      });
      return;
    } catch (err1) {
      const s1 = (err1 as AxiosError).response?.status;
      const d1 = (err1 as AxiosError).response?.data;
      this.logger.warn(`PUT /conversations/messages/{id}/status failed: ${s1} ${JSON.stringify(d1)}`);
      if (s1 === 403 && (d1 as any)?.message?.toString?.().includes('No conversation provider')) {
        this.logger.warn('Skipping status update due to missing conversation provider scope.');
        return;
      }
      try {
        await http.post('/conversations/messages/status', {
          messageId,
          status,
          conversationProviderId: meta.conversationProviderId || conversationProviderId,
          providerId: meta.providerId || conversationProviderId,
          ...meta,
        });
        return;
      } catch (err2) {
        const s2 = (err2 as AxiosError).response?.status;
        const d2 = (err2 as AxiosError).response?.data;
        this.logger.error(`Failed to update GHL message status: ${s2} ${JSON.stringify(d2)}`);
      }
    }
  }

  private async postInboundMessageToGhl(
    locationId: string,
    message: GhlPlatformMessage,
  ): Promise<void> {
    this.logger.log(
      `Posting message to GHL for location ${locationId} (direction=${message.direction}): ${message.message}`,
    );
    const httpClient = await this.getHttpClient(locationId);

    if (!message.contactId) {
      throw new IntegrationError('Missing contactId to post inbound message to GHL');
    }

    try {
      const payload: any = {
        ...message,
        locationId,
        body: (message as any).body ?? message.message,
        status: 'unread',
      };
      if (payload.timestamp) {
        payload.timestamp = new Date(payload.timestamp).toISOString();
      }
      const response = await httpClient.post(
        '/conversations/messages',
        payload,
      );
      const rid = (response.data?.message?.id || response.data?.id || response.data?.messageId);
      this.logger.log(`Mensaje enviado exitosamente a GHL. MessageId: ${rid ?? 'unknown'}`);
    } catch (err) {
      const axiosErr = err as AxiosError | any;
      this.logger.error(
        `[EvolutionApiService] Failed to post message to GHL via /conversations/messages: ${axiosErr?.response?.status || ''} ${JSON.stringify(axiosErr?.response?.data || axiosErr?.message)}`,
      );
      throw new IntegrationError('Failed to post message to GHL.');
    }
  }
}
