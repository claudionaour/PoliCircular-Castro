import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Ban,
  CheckCheck,
  CheckCircle2,
  Flag,
  Send,
  ShieldAlert,
  Star,
  Truck,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { getMatchDetail } from '../../services/matchingService';
import {
  ensureConversationForMatch,
  listMessages,
  markConversationMessagesRead,
  sendMessage,
  subscribeToConversationMessages,
  toggleConversationBlock,
} from '../../services/chatService';
import {
  cancelExchangeAgreementRpc,
  listMySubmittedReviewExchangeIds,
} from '../../services/exchangeService';
import { translateFirebaseError } from '../../services/firebase';
import { ReportModal } from '../../components/ReportModal';
import { ReviewFormModal } from '../reviews/ReviewFormModal';
import { EXCHANGE_STATUS_LABELS, formatChileDateTime } from '../../utils/formatters';
import type { Conversation, MatchRecord, Message } from '../../types/domain';

export const MatchRoomPage: React.FC = () => {
  const { matchId } = useParams<{ matchId: string }>();
  const { user } = useAuth();

  const [match, setMatch] = useState<MatchRecord | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [hasReviewed, setHasReviewed] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const loadData = useCallback(async () => {
    if (!matchId || !user) return;
    setLoading(true);
    setError(null);
    try {
      const [m, revIds] = await Promise.all([
        getMatchDetail(matchId),
        listMySubmittedReviewExchangeIds(user.uid),
      ]);
      setMatch(m);
      const exId = m?.exchanges?.[0]?.id;
      setHasReviewed(Boolean(exId && revIds.includes(exId)));

      let conv = m?.conversations?.[0] ?? null;
      if (m && !conv && (m.owner_id === user.uid || m.requester_id === user.uid)) {
        conv = await ensureConversationForMatch(m, user.uid);
      }
      setConversation(conv);

      if (conv) {
        const role =
          conv.participant_a === user.uid
            ? 'participant_a'
            : conv.participant_b === user.uid
              ? 'participant_b'
              : undefined;
        const msgs = await listMessages(conv.id, user.uid, role);
        setMessages(msgs);
        await markConversationMessagesRead(conv.id, user.uid, role).catch(() => {});
      }
    } catch (err) {
      setError(translateFirebaseError(err));
    } finally {
      setLoading(false);
    }
  }, [matchId, user]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const conversationId = conversation?.id;
  const userId = user?.uid;
  const participantRole =
    conversation && userId
      ? conversation.participant_a === userId
        ? 'participant_a'
        : conversation.participant_b === userId
          ? 'participant_b'
          : undefined
      : undefined;

  useEffect(() => {
    if (!conversationId || !userId) return;
    const channel = subscribeToConversationMessages(
      conversationId,
      (incoming) => {
        // Handler idempotente ordenado cronológicamente
        setMessages((prev) => {
          if (prev.some((m) => m.id === incoming.id)) return prev;
          return [...prev, incoming].sort(
            (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );
        });
        if (incoming.sender_id !== userId) {
          markConversationMessagesRead(conversationId, userId, participantRole).catch(() => {});
        }
      },
      (updated) => {
        setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      },
      { userId, participantRole }
    );

    return () => {
      channel.unsubscribe();
    };
  }, [conversationId, userId, participantRole]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!conversation || !user || !draft.trim() || conversation.is_blocked) return;
    setSending(true);
    setError(null);
    try {
      const sent = await sendMessage(conversation.id, user.uid, draft);
      setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]));
      setDraft('');
    } catch (err) {
      setError(translateFirebaseError(err));
    } finally {
      setSending(false);
    }
  };

  const handleBlockToggle = async () => {
    if (!conversation || !user) return;
    setError(null);
    const nextBlock = !conversation.is_blocked;
    try {
      await toggleConversationBlock(conversation.id, user.uid, nextBlock);
      setConversation({ ...conversation, is_blocked: nextBlock, blocked_by: nextBlock ? user.uid : null });
    } catch (err) {
      setError(translateFirebaseError(err));
    }
  };

  const handleCancelAgreement = async () => {
    const exchange = match?.exchanges?.[0];
    if (!exchange) return;
    try {
      await cancelExchangeAgreementRpc(exchange.id, 'Cancelado desde el chat del Match');
      await loadData();
    } catch (err) {
      setError(translateFirebaseError(err));
    }
  };

  if (loading) {
    return <div className="p-6 text-sm text-slate-200">Cargando chat privado...</div>;
  }

  if (!match || !conversation) {
    return (
      <div className="rounded-2xl bg-[#102C49] border border-[#244B73] p-8 text-center space-y-3">
        <p className="font-display font-bold text-white">
          {error ? 'No pudimos abrir el chat en este momento' : 'Conversación no encontrada o no autorizada'}
        </p>
        {error && <p className="text-xs text-red-200">{error}</p>}
        <Link to="/matches" className="mt-2 inline-block text-sm font-semibold text-[#FFA94D]">
          Volver a Mis Match
        </Link>
      </div>
    );
  }

  const other = match.owner_id === user?.uid ? match.requester : match.owner;
  const exchange = match.exchanges?.[0];
  const involvesMinor = Boolean(match.owner?.is_minor_supervised || match.requester?.is_minor_supervised);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/matches"
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 hover:text-[#FFA94D]"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Mis Match</span>
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          {exchange?.status === 'completed' ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#143D29] border border-[#34D399]/35 text-xs font-semibold text-[#6EE7B7]">
                <CheckCircle2 className="h-4 w-4" />
                <span>Confirmado · Sumado a tu Árbol</span>
              </span>
              {!hasReviewed && (
                <button
                  type="button"
                  onClick={() => setShowReview(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#F28C28] text-[#0B1E33] text-xs font-bold hover:bg-[#FFA242]"
                >
                  <Star className="h-4 w-4" />
                  <span>Evaluar</span>
                </button>
              )}
              <Link
                to="/intercambios"
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#3B648F] bg-[#102C49] text-xs font-semibold text-white hover:bg-[#163B61]"
              >
                <span>Historial</span>
              </Link>
            </>
          ) : (
            <Link
              to="/intercambios"
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#F28C28] text-[#0B1E33] text-xs font-bold hover:bg-[#FFA242]"
            >
              <Truck className="h-4 w-4" />
              <span>
                Historial ({exchange ? EXCHANGE_STATUS_LABELS[exchange.status] : 'Pendiente'})
              </span>
            </Link>
          )}
          <button
            type="button"
            onClick={handleBlockToggle}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-[#3B648F] bg-[#102C49] text-xs font-semibold text-white hover:bg-[#163B61]"
          >
            <Ban className="h-3.5 w-3.5" />
            <span>{conversation.is_blocked ? 'Desbloquear' : 'Bloquear'}</span>
          </button>
          <button
            type="button"
            onClick={() => setShowReport(true)}
            className="inline-flex items-center gap-1 px-3 py-2 rounded-xl border border-[#3B648F] bg-[#102C49] text-xs font-semibold text-white hover:text-red-300"
          >
            <Flag className="h-3.5 w-3.5" />
            <span>Denunciar</span>
          </button>
          {exchange && exchange.status !== 'completed' && exchange.status !== 'cancelled' && (
            <button
              type="button"
              onClick={handleCancelAgreement}
              className="px-3 py-2 rounded-xl border border-red-400/40 bg-red-950/70 text-xs font-semibold text-red-200"
            >
              Cancelar acuerdo
            </button>
          )}
        </div>
      </div>

      {involvesMinor && (
        <div className="rounded-xl bg-[#2A2015] border border-[#F28C28]/40 p-3 text-xs text-[#FDE68A] flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-[#FFA94D] shrink-0" />
          <span>
            Participa una cuenta escolar o supervisada. Acuerda entregas únicamente en establecimientos educacionales o puntos públicos comunitarios junto a un adulto responsable.
          </span>
        </div>
      )}

      <div className="rounded-2xl bg-[#102C49] border border-[#244B73] overflow-hidden flex flex-col h-[62vh] min-h-[420px]">
        <div className="px-5 py-3.5 border-b border-[#244B73] bg-[#081626] flex items-center justify-between">
          <div>
            <h1 className="font-display font-bold text-base text-white">
              Chat privado con {other?.full_name}
            </h1>
            <p className="text-xs text-slate-300">
              Producto: {match.target_product?.title} ({match.quantity_reserved} u.)
            </p>
          </div>
          <span className="text-xs font-semibold text-[#6EE7B7]">Tiempo real</span>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#0B1E33]">
          {messages.length === 0 ? (
            <p className="text-center text-xs text-slate-300 my-8">
              Inicia la conversación para coordinar fecha, horario y punto de encuentro público sin exponer domicilios particulares.
            </p>
          ) : (
            messages.map((msg) => {
              const isMine = msg.sender_id === user?.uid;
              return (
                <div
                  key={msg.id}
                  className={`flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                      isMine
                        ? 'bg-[#F28C28] text-[#0B1E33] font-medium'
                        : 'bg-[#102C49] text-white border border-[#244B73]'
                    }`}
                  >
                    <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-300">
                    <span>{formatChileDateTime(msg.created_at)}</span>
                    {isMine && (
                      <CheckCheck
                        className={`h-3.5 w-3.5 ${msg.is_read ? 'text-[#FFA94D]' : 'text-slate-400'}`}
                      />
                    )}
                  </div>
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        {error && (
          <div className="px-4 py-2 bg-red-950/70 border-t border-red-400/40 text-xs text-red-200">
            {error}
          </div>
        )}

        <form
          onSubmit={handleSend}
          className="p-3 border-t border-[#244B73] bg-[#081626] flex items-center gap-2"
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={conversation.is_blocked || sending}
            placeholder={
              conversation.is_blocked
                ? 'Esta conversación está bloqueada.'
                : 'Escribe un mensaje para coordinar...'
            }
            className="flex-1 rounded-xl border border-[#2D557F] bg-[#102C49] text-white placeholder:text-slate-400 px-3.5 py-2.5 text-sm focus:border-[#FFA94D] focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={conversation.is_blocked || sending || !draft.trim()}
            className="px-4 py-2.5 rounded-xl bg-[#F28C28] text-[#0B1E33] text-sm font-bold hover:bg-[#FFA242] disabled:opacity-50 inline-flex items-center gap-1.5 min-h-[44px]"
          >
            <Send className="h-4 w-4" />
            <span className="hidden sm:inline">Enviar</span>
          </button>
        </form>
      </div>

      {showReport && (
        <ReportModal
          targetType="conversation"
          targetId={conversation.id}
          targetTitle={`Conversación con ${other?.full_name}`}
          onClose={() => setShowReport(false)}
        />
      )}

      {showReview && exchange && (
        <ReviewFormModal
          exchangeId={exchange.id}
          targetName={other?.full_name || 'Participante'}
          onClose={() => setShowReview(false)}
          onSuccess={() => {
            setShowReview(false);
            setHasReviewed(true);
          }}
        />
      )}
    </div>
  );
};
