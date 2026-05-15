import { parseSignalMessage, scoreParsedSignal } from "../signal-parser.js";

const samples = [
  `Name: Track Hantavirus (TrackHanta)
Token: Dagi5m...pump
Dagi5mNUCkrTA8p225LFY1TxxMk5po8Mj1aCyewCpump
Mcap: $11.1K · Vol 5m: $29.9K
Distributed: 0.3202 SOL
Recipient: DAB7SL...YXyb (100.0%)
View TX`,
  `Bismillah Dawo Bot
New Alert

Name: Sheltercoin (SHELTERCOIN)
Token: Ac7sQy...uniP
Ac7sQyBkh8FUG3MkqgaBQnnbrrt4Mdx8d3yhBXv3dunjP
Mcap: $7.4K (peak x5) · Vol 5m: $1.4K
Type: charity
Distributed: 27.8009 SOL
Recipient: HeYs2K...wWz1 (100.0%)
View TX`,
];

for (const sample of samples) {
  const signal = parseSignalMessage(sample);
  const score = scoreParsedSignal(signal);
  console.log(JSON.stringify({ signal, score }, null, 2));
}
