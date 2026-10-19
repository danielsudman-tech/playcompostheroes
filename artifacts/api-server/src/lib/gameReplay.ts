import { WIN_FUNCTIONS } from "./cards.js";
import { createGameState, runBotTurnsIfNeeded, type GameState } from "./gameEngine.js";

export interface GameRoundSummary {
  roundNumber: number;
  winnerName: string | null;
  endedAt: number;
  turns: number;
  standings: Array<{ playerId: string; name: string; functionsFilled: number }>;
}

/** Only public final standings survive a replay, never hands, decks or decisions. */
export function restartFinishedGame(state: GameState, now = Date.now()): GameState {
  if (state.phase !== "game_over") throw new Error("Finish the current round before playing again");
  const roundNumber = state.roundNumber ?? 1;
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
    roundHistory: [...(state.roundHistory ?? []), summary],
    lastMeaningfulActivityAt: now,
  };
  next = runBotTurnsIfNeeded(next);
  return next;
}
