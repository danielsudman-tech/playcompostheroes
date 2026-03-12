export type CardType = "hero" | "action";
export type EffectType = "instant" | "ongoing";
export type CardFunction =
  | "Airflow"
  | "Carbon"
  | "Moisture"
  | "Nitrogen"
  | "Decomposer";

export interface Card {
  id: string;
  name: string;
  type: CardType;
  layer: string | null;
  effectType: EffectType;
  cardText: string;
  factText: string;
  function: string;
  imageKey: string | null;
}

const ALL_CARDS: Card[] = [
  // ── HERO CARDS ──
  {
    id: "breezy_bandit",
    name: "The Breezy Bandit",
    type: "hero",
    layer: "Air",
    effectType: "instant",
    cardText:
      "Swap 1 card from another player's compost pile with 1 from your compost pile.",
    factText:
      "Compost without enough air can turn anaerobic and smell like rotten eggs.",
    function: "Airflow",
    imageKey: null,
  },
  {
    id: "fresh_air_friend",
    name: "Fresh-Air Friend",
    type: "hero",
    layer: "Air",
    effectType: "instant",
    cardText: "Discard 1 card from your hand to draw 2 new cards.",
    factText: "Turning the pile introduces fresh air, accelerating composting.",
    function: "Airflow",
    imageKey: "Fresh_Air_Friend_1773283674656.jpg",
  },
  {
    id: "branch_buddy",
    name: "Branch Buddy",
    type: "hero",
    layer: "Air",
    effectType: "instant",
    cardText: "Discard 1 card from your hand to draw 1 card.",
    factText: "Bulky materials like twigs and wood chips create air pockets.",
    function: "Airflow",
    imageKey: "Branch_Buddy_1773283674654.jpg",
  },
  {
    id: "soggy_saver",
    name: "The Soggy Saver",
    type: "hero",
    layer: "Air",
    effectType: "ongoing",
    cardText: "Moisture cards cannot be removed from your compost pile.",
    factText:
      "By maintaining structure, bulky materials ensure good airflow and prevent soggy, anaerobic conditions.",
    function: "Airflow",
    imageKey: null,
  },
  {
    id: "sir_stink_no_more",
    name: "Sir Stink-No-More",
    type: "hero",
    layer: "Invertebrates",
    effectType: "ongoing",
    cardText: "You are unaffected by the Stinky Pile Action card.",
    factText:
      "Black soldier fly larvae devour scraps before they have a chance to smell.",
    function: "Airflow",
    imageKey: null,
  },
  {
    id: "wiggly_worker",
    name: "The Wiggly Worker",
    type: "hero",
    layer: "Invertebrates",
    effectType: "instant",
    cardText: "Draw 1 extra card.",
    factText: "Red wigglers can eat half their weight daily.",
    function: "Airflow",
    imageKey: null,
  },
  {
    id: "biochar",
    name: "Biochar",
    type: "hero",
    layer: "Leaf",
    effectType: "instant",
    cardText: "Search the discard pile for 1 Moisture card and add it to your hand.",
    factText:
      "Biochar's porous structure acts like a sponge, helping soil retain water and nutrients.",
    function: "Carbon",
    imageKey: "Biochar_1773283674654.jpg",
  },
  {
    id: "major_brown",
    name: "Major Brown",
    type: "hero",
    layer: "Leaf",
    effectType: "ongoing",
    cardText: "You are unaffected by the Soggy Pile Action card.",
    factText: "Shredded paper or cardboard are excellent \"browns\" for your compost.",
    function: "Carbon",
    imageKey: "Major_Brown_1773283674657.jpg",
  },
  {
    id: "brown_rogue",
    name: "Brown Rogue",
    type: "hero",
    layer: "Leaf",
    effectType: "instant",
    cardText:
      "Take 1 Nitrogen card from any player's compost pile and add it to your hand.",
    factText: "Carbon materials balance the C:N ratio to avoid odors.",
    function: "Carbon",
    imageKey: "Brown_Rogue_1773283674655.jpg",
  },
  {
    id: "stink_shield",
    name: "Stink Shield",
    type: "hero",
    layer: "Leaf",
    effectType: "ongoing",
    cardText:
      "You are unaffected by both the Soggy Pile and Stinky Pile Action cards.",
    factText:
      "Coarse \"browns\" like wood chips add air pockets & absorb moisture.",
    function: "Carbon",
    imageKey: null,
  },
  {
    id: "mycelial_alchemist",
    name: "Mycelial Alchemist",
    type: "hero",
    layer: "Mushroom",
    effectType: "instant",
    cardText:
      "All players must discard 1 Decomposer card from their compost pile (if they have one).",
    factText:
      "Fungi digest tough carbon while also storing precious nitrogen.",
    function: "Carbon",
    imageKey: "Mycelial_Alchemist_1773283674658.jpg",
  },
  {
    id: "under_web",
    name: "The Under-Web",
    type: "hero",
    layer: "Mushroom",
    effectType: "instant",
    cardText: "Swap 1 card from your hand with 1 card from the discard pile.",
    factText:
      "Mycelium are like nature's internet moving nutrients throughout the soil.",
    function: "Carbon",
    imageKey: null,
  },
  {
    id: "actinomycetes",
    name: "Actinomycetes",
    type: "hero",
    layer: "Bacteria",
    effectType: "instant",
    cardText:
      "Choose 1 Hero card from the discard pile and play it immediately into your compost pile.",
    factText:
      "Bacteria = Initial Workhorses; Fungi = Heavy Lifters; Actinomycetes = Master Finishers.",
    function: "Decomposer",
    imageKey: "Actinomycetes_1773283674654.jpg",
  },
  {
    id: "catalyst",
    name: "The Catalyst",
    type: "hero",
    layer: "Fire",
    effectType: "instant",
    cardText:
      "If you have 2 Decomposer cards in your compost pile, take another turn.",
    factText:
      "The hotter the pile gets, the faster specialized 'heat-loving' bacteria work.",
    function: "Decomposer",
    imageKey: null,
  },
  {
    id: "hot_head",
    name: "The Hot Head",
    type: "hero",
    layer: "Fire",
    effectType: "ongoing",
    cardText: "Each time you discard a Carbon card, draw 1 new card.",
    factText: "Heat is the energy released as microbes consume Carbon for fuel.",
    function: "Decomposer",
    imageKey: null,
  },
  {
    id: "old_timer",
    name: "The Old Timer",
    type: "hero",
    layer: "Time",
    effectType: "ongoing",
    cardText: "Your maximum hand size is increased to 6 cards.",
    factText:
      "Time is the ultimate compost hero — given weeks or years, it will break everything down into rich soil.",
    function: "Decomposer",
    imageKey: null,
  },
  {
    id: "captain_nectar",
    name: "Captain Nectar",
    type: "hero",
    layer: "Water",
    effectType: "instant",
    cardText: "Skip the next player's turn.",
    factText:
      "Fruit and vegetable scraps are an excellent source of moisture for a compost pile.",
    function: "Moisture",
    imageKey: "Captain_Nectar_1773283674655.jpg",
  },
  {
    id: "hydro_hauler",
    name: "The Hydro-Hauler",
    type: "hero",
    layer: "Water",
    effectType: "instant",
    cardText: "All players draw 1 card.",
    factText:
      "Moisture spreads through compost, sustaining microbial activity.",
    function: "Moisture",
    imageKey: null,
  },
  {
    id: "slumber_soaker",
    name: "The Slumber-Soaker",
    type: "hero",
    layer: "Water",
    effectType: "instant",
    cardText:
      "If you have 1 Decomposer card in your compost pile, draw 1 card.",
    factText:
      "Compost should feel like a wrung‑out sponge for best microbe activity.",
    function: "Moisture",
    imageKey: null,
  },
  {
    id: "microbial_marshal",
    name: "The Microbial Marshal",
    type: "hero",
    layer: "Broccoli",
    effectType: "instant",
    cardText: "If this is the first card in your compost pile, draw 2 cards.",
    factText: "A scoop of soil inoculates compost with microbes.",
    function: "Nitrogen",
    imageKey: null,
  },
  {
    id: "brown_bomber",
    name: "The Brown Bomber",
    type: "hero",
    layer: "Broccoli",
    effectType: "instant",
    cardText: "If you have 1 Carbon card in your compost pile, draw 1 card.",
    factText:
      "Manure from herbivores like chickens can rapidly spike nitrogen levels.",
    function: "Nitrogen",
    imageKey: null,
  },
  {
    id: "anaerobic_tyrant",
    name: "The Anaerobic Tyrant",
    type: "hero",
    layer: "Broccoli",
    effectType: "instant",
    cardText:
      "If you have 1 Decomposer or 1 Carbon card in your compost pile, draw 1 card.",
    factText:
      "Too many nitrogen-rich \"greens\" without enough carbon \"browns\" can lead to a slimy, smelly, anaerobic pile.",
    function: "Nitrogen",
    imageKey: null,
  },
  {
    id: "legion_of_life",
    name: "The Legion of Life",
    type: "hero",
    layer: "Bacteria",
    effectType: "instant",
    cardText: "Discard the active Ongoing Action Card if one is currently in play.",
    factText:
      "Just one teaspoon of healthy compost can contain over a billion beneficial bacteria.",
    function: "Nitrogen",
    imageKey: null,
  },
  {
    id: "quencher",
    name: "The Quencher",
    type: "hero",
    layer: "Bacteria",
    effectType: "ongoing",
    cardText:
      "Whenever a Moisture card is played into your compost pile, draw 1 extra card.",
    factText:
      "Moisture activates dormant bacteria, jump-starting their activity and driving decomposition.",
    function: "Nitrogen",
    imageKey: null,
  },
  // ── ACTION CARDS ──
  {
    id: "anaerobic_pocket",
    name: "Anaerobic Pocket",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText:
      "Discard 1 Airflow card from your compost pile. Then choose any opponent to skip their next turn.",
    factText:
      "Lack of air creates dense, smelly anaerobic pockets that can dramatically slow down the composting process.",
    function: "Action",
    imageKey: "Anaerobic_Pocket_1773283674654.jpg",
  },
  {
    id: "carbon_sink",
    name: "Carbon Sink",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText:
      "If you have 2 Carbon cards in your compost pile, you may take 1 Nitrogen card from an opponent's compost pile and add it to your own.",
    factText:
      "A compost pile that is too heavy in carbon can temporarily \"lock up\" nitrogen, slowing decomposition.",
    function: "Action",
    imageKey: "Carbon_Sink_1773283674655.jpg",
  },
  {
    id: "critical_mass",
    name: "Critical Mass",
    type: "action",
    layer: null,
    effectType: "ongoing",
    cardText:
      "If you have 2 cards of the same layer in your compost pile, you may draw 1 card.",
    factText:
      "Achieving a balanced ratio of ingredients fuels rapid decomposition.",
    function: "Action",
    imageKey: "Critical_Mass_1773283674656.jpg",
  },
  {
    id: "critter_raid",
    name: "Critter Raid",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText: "All players must discard 1 Nitrogen card from their hand (if they have one).",
    factText:
      "To deter pests and rodents, always cover freshly added food scraps with a layer of carbon-rich \"browns.\"",
    function: "Action",
    imageKey: "Critter_Raid_1773283674656.jpg",
  },
  {
    id: "dry_spell",
    name: "Dry Spell",
    type: "action",
    layer: null,
    effectType: "ongoing",
    cardText:
      "Players without a Moisture card in their compost pile have a maximum hand size of 3 cards.",
    factText:
      "Without moisture, microbes become dormant and decomposition stops.",
    function: "Action",
    imageKey: "Dry_Spell_1773283674656.jpg",
  },
  {
    id: "high_heat_gamble",
    name: "High Heat Gamble",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText: "Draw 3 cards. If none are Decomposers, skip your next turn.",
    factText:
      "High heat can either supercharge compost or kill key microbes.",
    function: "Action",
    imageKey: "High_Heat_Gamble_1773283674657.jpg",
  },
  {
    id: "hot_pile_bonus",
    name: "Hot Pile Bonus",
    type: "action",
    layer: null,
    effectType: "ongoing",
    cardText:
      "If you have 2 Decomposer cards in your compost pile, you may draw 1 extra card per turn.",
    factText:
      "A hot, active compost pile is a sign of a thriving ecosystem that is breaking down organic matter at maximum speed.",
    function: "Action",
    imageKey: "Hot_Pile_Bonus_1773283674657.jpg",
  },
  {
    id: "nitrogen_boost",
    name: "Nitrogen Boost",
    type: "action",
    layer: null,
    effectType: "ongoing",
    cardText: "You may discard 1 Nitrogen card from your hand to draw 2 cards.",
    factText: "Nitrogen-rich materials speed up compost breakdown.",
    function: "Action",
    imageKey: "Nitrogen_Boost_1773283674658.jpg",
  },
  {
    id: "plastic_contamination",
    name: "Plastic Contamination",
    type: "action",
    layer: null,
    effectType: "ongoing",
    cardText: "No player may add hero cards to their compost pile.",
    factText: "Plastic contamination can ruin compost unless it's sorted out.",
    function: "Action",
    imageKey: null,
  },
  {
    id: "rainstorm",
    name: "Rainstorm",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText:
      "Draw 2 cards. Any Moisture or Nitrogen cards drawn may be played into your compost pile immediately.",
    factText: "Moisture jump‑starts microbes.",
    function: "Action",
    imageKey: null,
  },
  {
    id: "rot_regrow",
    name: "Rot & Regrow",
    type: "action",
    layer: null,
    effectType: "ongoing",
    cardText:
      "You may discard 3 cards from your hand to take 1 card of your choice from the discard pile.",
    factText: "Compost breaks down and creates fresh soil full of nutrients.",
    function: "Action",
    imageKey: null,
  },
  {
    id: "soggy_pile",
    name: "Soggy Pile",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText:
      "Each player must discard either 1 Moisture or 1 Nitrogen card from their compost pile.",
    factText:
      "Excess water fills air spaces, depriving microbes of the oxygen they need to break down organic matter.",
    function: "Action",
    imageKey: null,
  },
  {
    id: "spread_nutrients",
    name: "Spread Nutrients",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText:
      "Give 1 card from your hand to each player. Then draw the same number of cards.",
    factText: "Nutrients spread through the ecosystem, benefiting everyone.",
    function: "Action",
    imageKey: null,
  },
  {
    id: "stinky_pile",
    name: "Stinky Pile",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText: "Each player must discard 1 Nitrogen card from their compost pile.",
    factText:
      "Stinky compost piles have too many \"greens\" (nitrogen) without enough \"browns\" (carbon) to balance them.",
    function: "Action",
    imageKey: null,
  },
  {
    id: "time_warp",
    name: "Time Warp",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText: "Take another full turn.",
    factText: "Ideal conditions speed compost.",
    function: "Action",
    imageKey: null,
  },
  {
    id: "worm_party",
    name: "Worm Party",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText:
      "Each player must choose 1 card from their hand and pass it to the player on their left.",
    factText:
      "Worm castings (poop) have 5 to 10 times more plant-available nutrients than the food they ate.",
    function: "Action",
    imageKey: null,
  },
  {
    id: "pile_flip",
    name: "Pile Flip",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText: "All players must pass their entire compost pile to the left.",
    factText:
      "Turning a compost pile helps mix layers, distribute moisture and air, and speeds up decomposition.",
    function: "Action",
    imageKey: "Pile_Flip_1773283674658.jpg",
  },
  {
    id: "rot_roulette",
    name: "Rot Roulette",
    type: "action",
    layer: null,
    effectType: "instant",
    cardText:
      "Draw 5 cards. Discard 3 immediately. Keep 2. Play 1 of them right away.",
    factText:
      "Not everything breaks down the same way—composting is part science, part surprise, depending on what you feed the pile.",
    function: "Action",
    imageKey: null,
  },
];

export function getAllCards(): Card[] {
  return ALL_CARDS;
}

export function getCardById(id: string): Card | undefined {
  return ALL_CARDS.find((c) => c.id === id);
}

// Build deck: heroes appear once each (34), actions appear once each (17)
export function buildDeck(): Card[] {
  const deck = [...ALL_CARDS];
  return deck;
}

export const WIN_FUNCTIONS: CardFunction[] = [
  "Airflow",
  "Carbon",
  "Moisture",
  "Nitrogen",
  "Decomposer",
];
