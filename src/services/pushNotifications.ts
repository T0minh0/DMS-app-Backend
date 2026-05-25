import { FastifyBaseLogger } from "fastify";
import { prisma } from "../prisma";

/**
 * Envio de Expo Push notifications.
 *
 * Usamos o endpoint publico do Expo (`https://exp.host/--/api/v2/push/send`)
 * que aceita tokens `ExponentPushToken[xxx]`. Documentacao:
 * https://docs.expo.dev/push-notifications/sending-notifications/
 *
 * Decisoes:
 * - **Best-effort**: falha de push NUNCA quebra o fluxo de pesagem. Erros
 *   sao logados em `log.warn` e o handler segue.
 * - **Limpeza de tokens invalidos**: quando o Expo responde com
 *   `DeviceNotRegistered`, removemos o token do banco — evita reenviar
 *   indefinidamente para devices desinstalados.
 * - **Batching**: enviamos varios tickets em uma chamada (limite Expo: 100).
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

interface ExpoPushMessage {
  to: string;
  sound?: "default";
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  priority?: "default" | "normal" | "high";
  channelId?: string;
}

interface ExpoPushTicketOk {
  status: "ok";
  id: string;
}

interface ExpoPushTicketError {
  status: "error";
  message?: string;
  details?: {
    error?:
      | "DeviceNotRegistered"
      | "MessageTooBig"
      | "MessageRateExceeded"
      | "MismatchSenderId"
      | "InvalidCredentials";
  };
}

type ExpoPushTicket = ExpoPushTicketOk | ExpoPushTicketError;

interface ExpoPushResponse {
  data?: ExpoPushTicket[];
  errors?: { message: string }[];
}

async function expoPushSend(
  messages: ExpoPushMessage[],
  log: FastifyBaseLogger
): Promise<ExpoPushTicket[]> {
  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(messages)
  });

  if (!response.ok) {
    log.warn(
      { status: response.status, statusText: response.statusText },
      "Expo Push API respondeu com erro HTTP."
    );
    return [];
  }

  const json = (await response.json()) as ExpoPushResponse;

  if (json.errors?.length) {
    log.warn({ errors: json.errors }, "Expo Push API retornou erros.");
  }

  return json.data ?? [];
}

interface SendWeighingNotificationParams {
  wastepickerId: bigint;
  materialName: string;
  weightGrams: number;
  weighingId: bigint;
  log: FastifyBaseLogger;
}

/**
 * Envia push para o catador notificando que uma pesagem foi registrada para
 * ele pelo gestor. Best-effort — nunca lanca.
 */
export async function sendWeighingNotification(
  params: SendWeighingNotificationParams
): Promise<void> {
  const { wastepickerId, materialName, weightGrams, weighingId, log } = params;

  try {
    const tokens = await prisma.workerPushToken.findMany({
      where: { workerId: wastepickerId },
      select: { token: true }
    });

    if (tokens.length === 0) {
      log.info(
        { wastepickerId: wastepickerId.toString() },
        "Catador nao tem push tokens registrados — pulando notificacao."
      );
      return;
    }

    const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
      to: token,
      sound: "default",
      title: "Pesagem registrada",
      body: `${weightGrams} g de ${materialName} foram registrados pelo gestor.`,
      data: {
        weighingId: weighingId.toString(),
        type: "weighing.created"
      },
      priority: "high",
      channelId: "default"
    }));

    const tickets = await expoPushSend(messages, log);

    // Limpa tokens reportados como `DeviceNotRegistered` — o app foi
    // desinstalado ou o token rotacionou.
    const invalidTokens: string[] = [];
    tickets.forEach((ticket, index) => {
      if (
        ticket.status === "error" &&
        ticket.details?.error === "DeviceNotRegistered"
      ) {
        invalidTokens.push(messages[index].to);
      }
    });

    if (invalidTokens.length > 0) {
      await prisma.workerPushToken.deleteMany({
        where: { token: { in: invalidTokens } }
      });
      log.info(
        { count: invalidTokens.length },
        "Tokens invalidos removidos apos DeviceNotRegistered."
      );
    }
  } catch (error) {
    log.warn(
      { err: error, wastepickerId: wastepickerId.toString() },
      "Falha ao enviar push notification — pesagem ja foi registrada."
    );
  }
}
