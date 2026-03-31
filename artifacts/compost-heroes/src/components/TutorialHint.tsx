import { useState, useEffect } from "react";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { GameState } from "@workspace/api-client-react";

const FUNCTIONS = ["Carbon", "Nitrogen", "Moisture", "Aeration", "Microbial"];

function getHint(
  gameState: GameState,
  isMyTurn: boolean,
  localPlayerId: string | null
): { title: string; body: string; tip?: string } {
  const pd = gameState.pendingDecision;
  const phase = gameState.phase;

  if (pd && isMyTurn) {
    switch (pd.type) {
      case "choose_function":
        return {
          title: "Choose a Function Category",
          body: "This hero can fill more than one function category. Pick the one you need most — you need one hero from each of the 5 categories to win.",
        };
      case "choose_card_from_hand":
        return {
          title: "Pick a Card from Your Hand",
          body: "Select a card from your hand to use for this effect. The highlighted card shows you which ones are eligible.",
        };
      case "choose_card_from_discard":
        return {
          title: "Raid the Discard Pile",
          body: "You get to pick any card from the discard pile and add it to your hand. Choose wisely!",
        };
      case "choose_hero_from_discard":
        return {
          title: "Rescue a Hero",
          body: "Pick any Hero card from the discard pile to place directly into your Compost Pile. This is a great way to fill a missing category!",
        };
      case "choose_opponent_for_steal":
        return {
          title: "Choose a Target",
          body: "Select which opponent's Compost Pile you want to steal from. Consider who has a hero you need!",
        };
      case "choose_steal_card":
        return {
          title: "Steal a Hero",
          body: "Choose a hero card to steal from their Compost Pile and add to yours. Pick one from a category you're missing.",
        };
      case "choose_card_from_compost":
        return {
          title: "Choose from Your Compost Pile",
          body: "Select one of your composted heroes for this effect.",
        };
      case "choose_discard_to_limit":
        return {
          title: "Hand Too Full!",
          body: "Your hand exceeds the limit. Select cards to discard until you're within the maximum hand size. Discard cards you don't need as much.",
        };
      case "choose_swap_opponent_breezy":
      case "choose_swap_their_card_breezy":
      case "choose_swap_my_card_breezy":
        return {
          title: "Breezy Bandit Swap",
          body: "The Breezy Bandit swaps heroes between compost piles. Choose which card(s) to exchange. You might gain a category you need — or lose one!",
        };
      case "choose_rainstorm_play":
        return {
          title: "Rainstorm: Play or Discard?",
          body: "Choose whether to play this card or send it to the discard pile. This happens for each card revealed.",
        };
      case "choose_discard_for_spread":
        return {
          title: "Choose a Card to Discard",
          body: "Select a card from your hand to discard as part of this effect.",
        };
      case "choose_target_player":
        return {
          title: "Choose a Player to Target",
          body: "Select which player this effect will apply to.",
        };
      case "choose_under_web_hand_card":
      case "choose_under_web_discard_card":
        return {
          title: "Spider Web",
          body: "Choose a card to trap in the web. Trapped cards are sent to the discard pile.",
        };
      case "choose_rot_roulette_keep":
        return {
          title: "Rot Roulette — Choose to Keep",
          body: "Rot Roulette forces you to give up heroes from your Compost Pile. Choose which one to keep — the rest go to the discard!",
        };
      case "choose_worm_party_card":
        return {
          title: "Worm Party!",
          body: "Pick a card from those revealed to play for free. Choose the one that helps you complete your 5-category collection.",
        };
      case "choose_rot_regrow_take":
        return {
          title: "Rot & Regrow",
          body: "Select a hero from the discard pile to bring back and add to your Compost Pile.",
        };
      case "choose_rot_regrow_discard":
      case "choose_nitrogen_boost_discard":
        return {
          title: "Discard a Card",
          body: "Choose a card from your hand to discard as the cost of this effect.",
        };
      case "choose_move_function":
        return {
          title: "Move a Hero's Function",
          body: "Choose which function category to reassign this hero to. Use this to fill a gap in your Compost Pile.",
        };
      default:
        return {
          title: "Make Your Choice",
          body: pd.prompt ?? "Select an option to continue.",
        };
    }
  }

  if (!isMyTurn) {
    const currentPlayer = gameState.players[gameState.currentPlayerIndex];
    if (pd) {
      return {
        title: `${currentPlayer.name} is deciding…`,
        body: "Another player is responding to a card effect. Hang tight!",
      };
    }
    if (phase === "draw") {
      return {
        title: `${currentPlayer.name}'s Turn`,
        body: "Waiting for them to draw a card. Watch their compost pile — they might grab something you need!",
        tip: "Keep track of what categories opponents have. If they're close to winning, you may need to play a defensive card.",
      };
    }
    return {
      title: `${currentPlayer.name} is Playing`,
      body: "Waiting for them to play cards and end their turn.",
      tip: "Use this time to plan your next move. What category are you still missing?",
    };
  }

  if (phase === "draw") {
    const myPlayer = gameState.players.find(p => p.id === localPlayerId);
    const handSize = myPlayer?.hand.length ?? 0;
    return {
      title: "Draw a Card",
      body: "Click the deck on the left to draw the top card, or click the discard pile to take the card on top.",
      tip: handSize === 0
        ? "Your hand is empty — you must draw from the deck."
        : "Taking from the discard lets you grab a specific card you've seen. The deck is a mystery!",
    };
  }

  if (phase === "play") {
    const heroPlayed = gameState.heroPlayedThisTurn;
    const actionPlayed = gameState.actionPlayedThisTurn;
    const myPlayer = gameState.players.find(p => p.id === localPlayerId);
    const myFunctions = new Set(
      (myPlayer?.compostPile ?? []).map(c => (c as any).effectiveFunction ?? c.function)
    );
    const missing = FUNCTIONS.filter(f => !myFunctions.has(f));

    if (heroPlayed && actionPlayed) {
      return {
        title: "All Done — End Your Turn",
        body: "You've played a Hero and an Action this turn. Click End Turn to pass to the next player.",
        tip: missing.length > 0
          ? `You still need: ${missing.join(", ")}.`
          : "You have all 5 categories — you should have won already!",
      };
    }
    if (heroPlayed) {
      return {
        title: "Hero Placed!",
        body: "You've placed a Hero in your Compost Pile this turn. You can still play 1 Action card, or click End Turn if you're done.",
        tip: missing.length > 0 ? `Still need: ${missing.join(", ")}.` : undefined,
      };
    }
    if (actionPlayed) {
      return {
        title: "Action Played!",
        body: "You've played an Action card this turn. You can still play 1 Hero to your Compost Pile, or click End Turn.",
        tip: missing.length > 0 ? `Still need: ${missing.join(", ")}.` : undefined,
      };
    }
    return {
      title: "Play Cards from Your Hand",
      body: "Tap a card in your hand to play it. Hero cards go to your Compost Pile (1 per turn). Action cards trigger special effects (1 per turn). Or click End Turn to skip.",
      tip: missing.length > 0
        ? `You need one hero from each of the 5 categories. Still missing: ${missing.join(", ")}.`
        : "You have all 5 categories — you win once you confirm!",
    };
  }

  return {
    title: "Compost Heroes",
    body: "Collect one Hero from each of the 5 function categories — Carbon, Nitrogen, Moisture, Aeration, and Microbial — to win!",
  };
}

interface TutorialHintProps {
  gameState: GameState;
  isMyTurn: boolean;
  localPlayerId: string | null;
}

const STORAGE_KEY = "compost_tutorial_mode";
const COLLAPSED_KEY = "compost_tutorial_collapsed";

export function useTutorialMode() {
  const [enabled, setEnabled] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) !== "off"; } catch { return true; }
  });

  const toggle = () => {
    setEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, next ? "on" : "off"); } catch {}
      return next;
    });
  };

  return { tutorialEnabled: enabled, toggleTutorial: toggle };
}

export function TutorialHint({ gameState, isMyTurn, localPlayerId }: TutorialHintProps) {
  const hint = getHint(gameState, isMyTurn, localPlayerId);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "yes"; } catch { return false; }
  });

  useEffect(() => {
    if (!collapsed) return;
    setCollapsed(false);
    try { localStorage.removeItem(COLLAPSED_KEY); } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hint.title]);

  const handleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(COLLAPSED_KEY, next ? "yes" : "no"); } catch {}
  };

  return (
    <>
      {/* Mobile: pinned just below the top bar, full-width */}
      <div className={cn(
        "md:hidden fixed top-12 inset-x-2 z-40 rounded-xl border bg-background/95 backdrop-blur-md shadow-lg transition-all duration-200",
        "border-primary/30"
      )}>
        <div
          className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
          onClick={handleCollapse}
        >
          <BookOpen className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          <span className="text-xs font-bold text-primary flex-1 truncate">{hint.title}</span>
          {collapsed
            ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          }
        </div>
        {!collapsed && (
          <div className="px-3 pb-3 space-y-1.5">
            <p className="text-xs text-foreground/80 leading-relaxed">{hint.body}</p>
            {hint.tip && (
              <p className="text-xs text-muted-foreground leading-relaxed border-t border-border pt-1.5">
                💡 {hint.tip}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Desktop: bottom-left, fixed width */}
      <div className={cn(
        "hidden md:block fixed bottom-4 left-4 z-40 w-72 rounded-xl border bg-background/95 backdrop-blur-md shadow-lg transition-all duration-200",
        "border-primary/30"
      )}>
        <div
          className="flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none"
          onClick={handleCollapse}
        >
          <BookOpen className="w-3.5 h-3.5 text-primary flex-shrink-0" />
          <span className="text-xs font-bold text-primary flex-1 truncate">{hint.title}</span>
          {collapsed
            ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
            : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
          }
        </div>
        {!collapsed && (
          <div className="px-3 pb-3 space-y-1.5">
            <p className="text-xs text-foreground/80 leading-relaxed">{hint.body}</p>
            {hint.tip && (
              <p className="text-xs text-muted-foreground leading-relaxed border-t border-border pt-1.5">
                💡 {hint.tip}
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
