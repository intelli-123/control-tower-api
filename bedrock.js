/**
 * bedrock.js — list agents from AWS Bedrock (Agents for Amazon Bedrock).
 *
 * Uses @aws-sdk/client-bedrock-agent ListAgentsCommand. The client factory is
 * injectable so the mapping/pagination can be unit-tested without real AWS.
 */
let _clientFactory = null;
/** Test seam: pass a factory ({region,credentials}) => { send(cmd) }. */
function setClientFactory(fn) { _clientFactory = fn; }

function makeClient({ region, accessKeyId, secretAccessKey, sessionToken }) {
  if (_clientFactory) return _clientFactory({ region, accessKeyId, secretAccessKey, sessionToken });
  const { BedrockAgentClient } = require('@aws-sdk/client-bedrock-agent');
  return new BedrockAgentClient({
    region: region || 'us-east-1',
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
  });
}

/** List all agents for one account (handles pagination). Returns normalized rows. */
async function listAgents(creds) {
  const { ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent');
  const client = makeClient(creds);
  const out = [];
  let nextToken;
  do {
    const res = await client.send(new ListAgentsCommand({ maxResults: 100, nextToken }));
    for (const a of (res.agentSummaries || [])) {
      out.push({
        agentId:    a.agentId,
        agentName:  a.agentName,
        status:     a.agentStatus,                 // PREPARED | NOT_PREPARED | CREATING | FAILED | ...
        description: a.description || null,
        latestVersion: a.latestAgentVersion || null,
        updatedAt:  a.updatedAt || null,
      });
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}

module.exports = { listAgents, setClientFactory };
