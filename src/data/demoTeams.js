// DEMO TEAMS — fictional names for rehearsal only (is_demo: true).
// Remove them from Settings → "Remove demo data" before entering real teams.
const UG_NAMES = [
  ['Frost Byte', 'Demo Aarav', 'Demo Diya'],
  ['Null Pointers', 'Demo Kabir', 'Demo Meera'],
  ['Polar Stack', 'Demo Rohan', 'Demo Anaya'],
  ['Glacier Logic', 'Demo Vihaan', 'Demo Saanvi'],
  ['Cryo Coders', 'Demo Arjun', 'Demo Ishita'],
  ['Ice Queue', 'Demo Reyansh', 'Demo Kiara'],
  ['Subzero Syntax', 'Demo Aditya', 'Demo Myra'],
  ['Blizzard Bits', 'Demo Krish', 'Demo Aadhya'],
  ['Permafrost', 'Demo Ayaan', 'Demo Navya'],
  ['Snowflake Schema', 'Demo Dhruv', 'Demo Riya'],
  ['Arctic Arrays', 'Demo Ishaan', 'Demo Tara'],
  ['Cold Cache', 'Demo Neel', 'Demo Zoya'],
];
const PG_NAMES = [
  ['Tundra Threads', 'Demo Kavya', 'Demo Samar'],
  ['Hailstorm Heap', 'Demo Pari', 'Demo Advik'],
  ['Icicle Index', 'Demo Siya', 'Demo Rudra'],
  ['Frozen Kernel', 'Demo Anvi', 'Demo Veer'],
  ['Sleet Sockets', 'Demo Ira', 'Demo Kian'],
  ['Northwind Nodes', 'Demo Ahana', 'Demo Yash'],
];

const build = (names, college) => names.map(([team_name, participant_1, participant_2], i) => ({
  team_number: i + 1,
  team_name: `${team_name} (Demo)`,
  participant_1,
  participant_2,
  college_name: college,
  is_demo: true,
}));

// No `section` field: "Load demo teams" imports them into the section being viewed.
export const DEMO_TEAMS = build(UG_NAMES, 'Demo College of Computing');
export const DEMO_PG_TEAMS = build(PG_NAMES, 'Demo Institute of Technology');
