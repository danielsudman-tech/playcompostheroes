/**
 * Remove hidden-hand identities from current and legacy recap prose.
 *
 * Recap entries can contain user-controlled player names as well as card
 * names, and older entries do not consistently identify the card's zone.
 * For hand-related operations emit fixed summaries rather than reusing any
 * parsed fragment as a supposedly safe name or label.
 */
export function sanitizeRecapLog(
  log: readonly string[],
  knownCardNames: readonly string[] = [],
): string[] {
  const cardNames = [...new Set(knownCardNames.filter(Boolean))]
    .sort((a, b) => b.length - a.length);

  return log.map((rawLine) => {
    const line = typeof rawLine === "string" ? rawLine : "";

    // Public played-card rules text, not a record of a selected hand card.
    if (/^Critter Raid!\s+All players must discard \d+ Nitrogen card from hand\.?$/i.test(line)) {
      return line;
    }

    const publicPlay = publicPlayedCard(line, cardNames);
    if (publicPlay) return publicPlay;

    const publicCompostDiscard = publicCompostDiscardCard(line, cardNames);
    if (publicCompostDiscard) return publicCompostDiscard;

    const publicPileTake = publicPileTakeCard(line, cardNames);
    if (publicPileTake) return publicPileTake;

    // Worm Party legacy lines included names and card identities. Do not
    // derive counts from comma-separated free-form names/card labels either.
    if (/worm party/i.test(line) && /\b(?:passed|pass|transfer(?:red)?)\b/i.test(line)) {
      return "Worm Party — passed-card details are hidden.";
    }

    if (/hand exceeded limit/i.test(line) && /auto-discarded/i.test(line)) {
      return "A hand-limit discard occurred.";
    }
    if (/\bdiscarded\b/i.test(line) && /\bfrom (?:your |their )?hand\b/i.test(line)) {
      return "A player discarded a card from hand.";
    }
    if (/\bdiscarded\b/i.test(line) && /\(Nitrogen\)\s+to draw 2 cards\b/i.test(line)) {
      return "A player discarded a Nitrogen card from hand.";
    }
    if (/\bdiscarded\b/i.test(line) && /\bto meet hand limit\b/i.test(line)) {
      return "A player discarded cards to meet the hand limit.";
    }
    if (/\bdiscarded\b/i.test(line) && /\bfor Rot\s*&\s*Regrow\b/i.test(line)) {
      return "A player discarded cards for Rot & Regrow.";
    }

    // Hand transfers and exchanges can place identities in any grammar slot
    // (including the recipient or the apparent discard-pile side). Never
    // trust a captured fragment from these legacy formats.
    if (/\bgave\b/i.test(line) && /\bto\b/i.test(line)) {
      return "A hidden-hand card was transferred.";
    }
    if (/\bswapp?ed\b/i.test(line) && /\b(?:hand|discard)\b/i.test(line)) {
      return "A hidden-hand exchange occurred; card details are hidden.";
    }

    // Critter Raid and other older bare-discard formats did not say whether
    // the card came from hand or a public pile. Treat every unqualified
    // named discard as hidden, regardless of words in the actor's name.
    if (/\bdiscarded\b/i.test(line)) {
      return "A player discarded a card.";
    }

    // If a known card identity appears in an otherwise unfamiliar hand/pass/
    // exchange line, withhold the whole detail instead of trying to preserve
    // labels or split public and private fragments by punctuation.
    if (
      containsKnownCardName(line, cardNames) &&
      /\b(hand|passed|pass|give|gave|transfer|swap|exchange|sent|receive|received|forwarded|took|stole|handed|selected|chose|picked)\b/i.test(line)
    ) {
      return "Hidden-hand card details withheld.";
    }

    return line;
  });
}

function publicCompostDiscardCard(line: string, cardNames: readonly string[]): string | null {
  const normalizedLine = line.toLocaleLowerCase();
  const publicEndings = [
    " from compost.",
    " from compost (only eligible card).",
    " from compost (soggy pile).",
  ];

  for (const cardName of cardNames) {
    const normalizedName = cardName.toLocaleLowerCase();
    // This card label itself could imitate the zone marker, so that case is
    // ambiguous and must not authorize a public disclosure.
    if (/\bfrom compost\b/i.test(cardName)) continue;
    for (const ending of publicEndings) {
      const suffix = ` discarded ${normalizedName}${ending}`;
      if (normalizedLine.endsWith(suffix)) {
        return `A public compost card was discarded: ${cardName}.`;
      }
    }
  }
  return null;
}

function publicPlayedCard(line: string, cardNames: readonly string[]): string | null {
  const lowerLine = line.toLocaleLowerCase();
  const playEndings = [
    (name: string) => ` played ${name}.`,
    (name: string) => ` played ${name} — choose which function slot to fill.`,
    (name: string) => ` played ${name} into their compost pile.`,
    (name: string) => ` played ${name} (effect applied).`,
    (name: string) => ` played ${name} (ongoing effect now active).`,
    (name: string) => ` played ${name} to compost (rainstorm).`,
  ];

  for (const cardName of cardNames) {
    const normalizedName = cardName.toLocaleLowerCase();
    if (playEndings.some((makeEnding) => lowerLine.endsWith(makeEnding(normalizedName)))) {
      return `A player publicly played ${cardName}.`;
    }

    const ongoingStart = `${normalizedName} ongoing effect is now active for `;
    if (lowerLine.startsWith(ongoingStart) && lowerLine.endsWith(".")) {
      return `A public ongoing effect is active: ${cardName}.`;
    }

    const placedDiscard = ` placed ${normalizedName} from discard into compost (actinomycetes).`;
    if (lowerLine.endsWith(placedDiscard)) {
      return `A public discard-pile card entered compost: ${cardName}.`;
    }

    const placedInPile = ` placed ${normalizedName} into the `;
    const placedIndex = lowerLine.lastIndexOf(placedInPile);
    if (placedIndex >= 0 && lowerLine.endsWith(" slot.")) {
      return `A public card entered a compost slot: ${cardName}.`;
    }
  }
  return null;
}

function publicPileTakeCard(line: string, cardNames: readonly string[]): string | null {
  const normalizedLine = line.toLocaleLowerCase();

  for (const cardName of cardNames) {
    const normalizedName = cardName.toLocaleLowerCase();
    const discardSuffixes = [
      ` took ${normalizedName} from discard pile into hand.`,
      ` took ${normalizedName} from discard pile (rot & regrow).`,
      ` chose ${normalizedName} from discard — select a function slot.`,
    ];
    if (discardSuffixes.some((suffix) => normalizedLine.endsWith(suffix))) {
      return `A public discard-pile card was taken: ${cardName}.`;
    }

    const compostTake = ` took ${normalizedName} from `;
    const compostTakeIndex = normalizedLine.lastIndexOf(compostTake);
    if (
      compostTakeIndex >= 0 &&
      / from .+'s compost into hand\.$/i.test(normalizedLine.slice(compostTakeIndex + ` took ${normalizedName}`.length))
    ) {
      return `A public compost card was taken into hand: ${cardName}.`;
    }
  }
  return null;
}

function containsKnownCardName(line: string, cardNames: readonly string[]): boolean {
  const normalizedLine = line.toLocaleLowerCase();
  return cardNames.some((cardName) => normalizedLine.includes(cardName.toLocaleLowerCase()));
}