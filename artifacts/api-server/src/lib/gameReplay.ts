import { WIN_FUNCTIONS } from "./cards.js";
import { createGameState, runBotTurnsIfNeeded, type GameState, type PlayerState } from "./gameEngine.js";

export interface GameRoundSummary {
  roundNumber: number;
  winnerName: string | null;
  endedAt: number;
  turns: number;
  standings: Array<{ playerId: string; name: string; functionsFilled: number }>;
}

/** Archive before editing seats, so a departing winner cannot erase results. */
export function archiveFinishedRound(state: GameState, now = Date.now()): GameState {
  if (state.phase !== "game_over") return state;
  const roundNumber = state.roundNumber ?? 1;
  if (state.roundHistory?.some(round => round.roundNumber === roundNumber)) return state;
  const summary: GameRoundSummary = {
    roundNumber,
    winnerName: state.players.find(player => player.id === state.winner)?.name ?? null,
    endedAt: state.endedAt ?? now,
    turns: state.turnNumber,
    standings: state.players.map(player => ({
      playerId: player.id,
      name: player.name,
      functionsFilled: WIN_FUNCTIONS.filter(fn =>
        player.compostPile.some(card => (card.chosenFunction ?? card.function) === fn)).length,
    })),
  };
  return { ...state, roundHistory: [...(state.roundHistory ?? []), summary] };
}

export function updateRoundRoster(state: GameState, players: PlayerState[]): GameState {
  return {
    ...archiveFinishedRound(state),
    players,
    currentPlayerIndex: Math.min(state.currentPlayerIndex, Math.max(0, players.length - 1)),
    replayReadyPlayerIds: [],
    lastMeaningfulActivityAt: Date.now(),
  };
}

/** Only public final standings survive a replay, never hands, decks or decisions. */
export function restartFinishedGame(state: GameState, now = Date.now()): GameState {
  if (state.phase !== "game_over") throw new Error("Finish the current round before playing again");
  if (state.players.length < 2) throw new Error("At least two players are needed to start another round");
  const roundNumber = state.roundNumber ?? 1;
  const bots = state.players.flatMap((player, index) => player.isBot ? [index] : []);
  const skills = Object.fromEntries(state.players.flatMap((player, index) =>
    player.botSkillLevel ? [[index, player.botSkillLevel]] : []));
  let next = createGameState(state.gameId, state.players.map(player => player.name), state.mode, bots, skills);
  next.players = next.players.map((player, index) => ({
    ...player,
    id: state.players[index].id,
    botCovering: state.players[index].botCovering,
    botCoverReason: state.players[index].botCoverReason,
    consecutiveMissedTurns: 0,
  }));
  next = {
    ...next,
    replayReadyPlayerIds: [],
    facilitatorId: state.facilitatorId,
    eventId: state.eventId,
    createdAt: state.createdAt,
    label: state.label,
    maxPlayers: state.maxPlayers,
    hostIsSpectator: state.hostIsSpectator,
    turnTimerSeconds: state.turnTimerSeconds,
    turnSequence: (state.turnSequence ?? 0) + 1,
    botUpdateSequence: state.botUpdateSequence,
    systemUpdateSequence: state.systemUpdateSequence,
    roundNumber: roundNumber + 1,
    roundStartedAt: now,
    analyticsRoundId: `${state.gameId}:round:${roundNumber + 1}`,
    roundHistory: archiveFinishedRound(state, now).roundHistory,
    lastMeaningfulActivityAt: now,
  };
  next = runBotTurnsIfNeeded(next);
  return next;
}
