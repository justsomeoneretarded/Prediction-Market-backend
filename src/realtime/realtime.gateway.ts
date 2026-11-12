import { Logger } from '@nestjs/common';
import { OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer, ConnectedSocket, MessageBody } from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { parse as parseCookie } from './cookie';
import { AuthService } from '../auth/auth.service';
import { SESSION_COOKIE } from '../auth/auth.types';
import { config } from '../config';

/**
 * Live updates over Socket.IO. The database stays authoritative: every event is emitted
 * only AFTER the transaction that produced it has committed, and clients re-fetch from the
 * API when they (re)connect.
 *   rooms:  market:<id>  (public)   user:<id>  (private, from the session cookie)
 */
@WebSocketGateway({
  path: '/socket.io',
  cors: { origin: config().WEB_ORIGIN.split(','), credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection {
  private readonly log = new Logger('Realtime');
  @WebSocketServer() server: Server;

  constructor(private readonly auth: AuthService) {}

  async handleConnection(socket: Socket) {
    try {
      const token = parseCookie(socket.handshake.headers.cookie ?? '')[SESSION_COOKIE];
      if (token) {
        const user = await this.auth.resolveSession(token);
        if (user) await socket.join(`user:${user.id}`);
      }
    } catch (e) {
      this.log.warn(`socket auth failed: ${(e as Error).message}`);
    }
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: { markets?: string[] }) {
    const ids = (body?.markets ?? []).filter((m) => typeof m === 'string').slice(0, 100);
    await Promise.all(ids.map((id) => socket.join(`market:${id}`)));
    return { ok: true };
  }

  @SubscribeMessage('subscribe:all')
  async subscribeAll(@ConnectedSocket() socket: Socket) {
    await socket.join('markets');
    return { ok: true };
  }

  emitMarket(marketId: string, event: string, payload: unknown) {
    this.server?.to(`market:${marketId}`).to('markets').emit(event, payload);
  }
  emitUser(userId: string, event: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
}
