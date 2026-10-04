import { takeOverPlayerAsBot, type GameState } from "./gameEngine.js";

export function resetMissedTurns(state: GameState, playerId: string): GameState {
  return { ...state, players: state.players.map(p => p.id === playerId ? { ...p, consecutiveMissedTurns: 0 } : p) };
}

export function coverHumanSeat(state: GameState, playerId: string, temporary = true): GameState {
  const next = takeOverPlayerAsBot(state, playerId);
  return { ...next, players: next.players.map(p => p.id === playerId
    ? { ...p, isBot: true, botSkillLevel: "medium", botCovering: temporary, botCoverReason: temporary ? "host" : undefined } : p) };
}

export function recordMissedTurn(state: GameState, playerId: string, turnNumber: number): GameState {
  const actor = state.players.find(p => p.id === playerId);
  if (!actor || actor.isBot || actor.lastMissedTurnNumber === turnNumber) return state;
  const count = (actor.consecutiveMissedTurns ?? 0) + 1;
  let next = { ...state, players: state.players.map(p => p.id === playerId
    ? { ...p, consecutiveMissedTurns: count, lastMissedTurnNumber: turnNumber } : p) };
  if (count >= 2) {
    next = coverHumanSeat(next, playerId);
    next = { ...next, players: next.players.map(p => p.id === playerId ? { ...p, botCoverReason: "timer" as const } : p) };
    next = { ...next, log: [...next.log, `${actor.name} missed two turns. A bot is covering for them.`] };
  }
  return next;
}

export function returnCoveredSeat(state: GameState, playerId: string): GameState {
  const player = state.players.find(p => p.id === playerId);
  if (!player?.botCovering) return state;
  const isActor = (state.pendingDecision?.playerId ?? state.players[state.currentPlayerIndex]?.id) === playerId;
  return { ...state,
    players: state.players.map(p => p.id === playerId
      ? { ...p, isBot: false, botCovering: false, botCoverReason: undefined, consecutiveMissedTurns: 0 } : p),
    ...(isActor ? { turnDeadlineAt: null, turnTimerRemainingMs: null, turnDeadlineKey: null } : {}),
    log: [...state.log, `${player.name} is back.`] };
}