"""
control_tower.py — Drop-in SDK for Python agents

Usage (any framework — LangChain, CrewAI, raw Anthropic SDK):

    from control_tower import ControlTower

    ct = ControlTower(
        agent_id    = "finance-agent-01",
        name        = "Finance Agent",
        department  = "Finance",
        server_url  = "http://localhost:3000",  # your Control Tower API
    )

    # Start heartbeat loop in background (auto-discovers tools)
    ct.start(tools=my_agent.tools)

    # Wrap every LLM call to auto-capture tokens
    response = ct.track(client.messages.create(...))

    # Report a tool call
    ct.tool_call("query_db", params={"q": "SELECT ..."})

    # Report something that needs human approval
    escalation_id = ct.escalate("Should I reject this $48K invoice?", context="INV-8841")
    decision = ct.wait_for_decision(escalation_id)   # blocks until human responds

    # Trigger another agent
    run_id = ct.trigger("hr-agent-01", task="Onboard Alex Chen")
"""

import asyncio
import threading
import time
import inspect
import sys
import logging
from typing import Any, Callable, Dict, List, Optional, Union

try:
    import httpx
    _HTTP_CLIENT = "httpx"
except ImportError:
    import urllib.request, json as _json, urllib.error
    _HTTP_CLIENT = "urllib"

logger = logging.getLogger("control_tower")


class ControlTower:
    def __init__(
        self,
        agent_id:    str,
        server_url:  str  = "http://localhost:3090",
        name:        str  = None,
        department:  str  = "Unknown",
        model:       str  = None,
        heartbeat_interval: int = 30,   # seconds
        auto_discover_tools: bool = True,
    ):
        self.agent_id   = agent_id
        self.server_url = server_url.rstrip("/")
        self.name       = name or agent_id
        self.department = department
        self.model      = model
        self.interval   = heartbeat_interval

        # Rolling metrics — reset each heartbeat
        self._tokens_input  = 0
        self._tokens_output = 0
        self._calls_made    = 0
        self._error_count   = 0
        self._latencies     = []
        self._recent_tools  = []

        # Status tracking
        self._status       = "ready"
        self._current_task = None
        self._tools        = []

        # Background heartbeat thread
        self._thread  = None
        self._running = False

        if auto_discover_tools:
            self._tools = self._discover_tools()

    # ── Public API ─────────────────────────────────────────────────────────────

    def start(self, tools=None, get_status: Callable = None):
        """
        Start the background heartbeat loop.
        
        tools      — pass your agent.tools list (LangChain/CrewAI) or any iterable.
                     Each item needs a .name attribute, or be a string.
        get_status — optional callable that returns current status string.
        """
        if tools:
            self._tools = self._normalize_tools(tools)

        self._get_status_fn = get_status
        self._running = True

        self._thread = threading.Thread(target=self._heartbeat_loop, daemon=True)
        self._thread.start()
        logger.info(f"[ControlTower] Heartbeat started for {self.agent_id} → {self.server_url}")
        return self

    def stop(self):
        """Stop the heartbeat loop."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=5)

    def set_status(self, status: str, task: str = None):
        """Update agent status. Call at start/end of tasks."""
        self._status = status
        if task is not None:
            self._current_task = task

    def set_tools(self, tools):
        """Update the tool list dynamically."""
        self._tools = self._normalize_tools(tools)

    def track(self, response):
        """
        Wrap any Anthropic/OpenAI SDK response to auto-capture tokens.

        Usage:
            response = ct.track(client.messages.create(...))
        """
        try:
            # Anthropic SDK
            if hasattr(response, "usage"):
                u = response.usage
                self._tokens_input  += getattr(u, "input_tokens", 0)
                self._tokens_output += getattr(u, "output_tokens", 0)
                self._calls_made    += 1

                # Emit an audit event immediately
                self._post("/api/heartbeat", self._build_payload(
                    event="llm_response",
                    event_detail=f"Tokens: in={getattr(u,'input_tokens',0)} out={getattr(u,'output_tokens',0)}"
                ))
        except Exception as e:
            logger.debug(f"[ControlTower] track() error: {e}")
        return response

    def tool_call(self, tool_name: str, params: Dict = None, result: Any = None, error: str = None):
        """Report a tool invocation."""
        self._recent_tools.append(tool_name)
        if len(self._recent_tools) > 20:
            self._recent_tools = self._recent_tools[-20:]

        if error:
            self._error_count += 1

        detail = f"{tool_name}({params or ''})"
        if error:
            detail += f" → ERROR: {error}"

        self._post("/api/heartbeat", self._build_payload(
            event="tool_call",
            event_detail=detail
        ))

    def task_start(self, task: str):
        """Call when your agent starts a new task."""
        self.set_status("busy", task)
        self._post("/api/heartbeat", self._build_payload(
            event="task_start",
            event_detail=task
        ))

    def task_complete(self, task: str = None, result: str = None):
        """Call when your agent completes a task."""
        self.set_status("ready", None)
        self._post("/api/heartbeat", self._build_payload(
            event="task_complete",
            event_detail=result or task or "Task completed"
        ))

    def escalate(self, question: str, context: str = "", urgency: str = "normal",
                 options: List[str] = None) -> str:
        """
        Create a human escalation. Returns escalation_id.
        The agent should then call wait_for_decision(escalation_id).
        """
        resp = self._post("/api/escalation", {
            "agent_id": self.agent_id,
            "question": question,
            "context":  context,
            "urgency":  urgency,
            "options":  options or ["approve", "reject"],
        })
        if resp and "escalation_id" in resp:
            return resp["escalation_id"]
        raise RuntimeError(f"Failed to create escalation: {resp}")

    def wait_for_decision(self, escalation_id: str, poll_interval: int = 5,
                          timeout: int = 3600) -> str:
        """
        Block until a human makes a decision on the escalation.
        Returns the decision string: 'approved' | 'rejected' | 'hold'
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            resp = self._get(f"/api/escalations/{escalation_id}")
            if resp and resp.get("status") in ("resolved", "on_hold"):
                return resp.get("decision", "unknown")
            time.sleep(poll_interval)
        raise TimeoutError(f"No decision for escalation {escalation_id} after {timeout}s")

    def trigger(self, agent_id: str, task: str, priority: str = "normal",
                params: Dict = None) -> str:
        """
        Trigger another agent. Returns run_id.
        """
        resp = self._post("/api/trigger", {
            "agent_id":     agent_id,
            "task":         task,
            "priority":     priority,
            "triggered_by": self.agent_id,
            "params":       params or {},
        })
        if resp and "run_id" in resp:
            return resp["run_id"]
        raise RuntimeError(f"Failed to trigger agent: {resp}")

    # ── LangChain callback (auto token tracking) ───────────────────────────────

    def as_langchain_callback(self):
        """
        Returns a LangChain callback handler that auto-tracks tokens.

        Usage:
            agent = initialize_agent(..., callbacks=[ct.as_langchain_callback()])
        """
        ct = self
        try:
            from langchain.callbacks.base import BaseCallbackHandler

            class CTCallback(BaseCallbackHandler):
                def on_llm_end(self, response, **kwargs):
                    usage = response.llm_output.get("token_usage", {}) if response.llm_output else {}
                    ct._tokens_input  += usage.get("prompt_tokens", 0)
                    ct._tokens_output += usage.get("completion_tokens", 0)
                    ct._calls_made    += 1

                def on_tool_start(self, serialized, input_str, **kwargs):
                    ct.tool_call(serialized.get("name", "unknown"), {"input": input_str[:200]})

                def on_tool_error(self, error, **kwargs):
                    ct._error_count += 1

                def on_agent_action(self, action, **kwargs):
                    ct.set_status("busy", str(action.tool)[:100])

                def on_agent_finish(self, finish, **kwargs):
                    ct.set_status("ready")

            return CTCallback()
        except ImportError:
            logger.warning("[ControlTower] LangChain not installed — callback unavailable")
            return None

    def as_crewai_callback(self):
        """Returns a CrewAI-compatible step callback."""
        ct = self
        def step_callback(step):
            if hasattr(step, "tool"):
                ct.tool_call(step.tool, {"input": str(step.tool_input)[:200]})
        return step_callback

    # ── Internals ──────────────────────────────────────────────────────────────

    def _heartbeat_loop(self):
        while self._running:
            try:
                status = self._status
                if self._get_status_fn:
                    try:
                        status = self._get_status_fn()
                    except Exception:
                        pass

                payload = self._build_payload(status=status)
                self._post("/api/heartbeat", payload)

                # Reset per-interval counters
                self._tokens_input  = 0
                self._tokens_output = 0
                self._calls_made    = 0
                self._error_count   = 0
                self._latencies     = []
                self._recent_tools  = []

            except Exception as e:
                logger.debug(f"[ControlTower] Heartbeat error: {e}")

            time.sleep(self.interval)

    def _build_payload(self, status: str = None, event: str = None,
                       event_detail: str = None) -> Dict:
        total_tokens = self._tokens_input + self._tokens_output
        error_rate   = (self._error_count / max(self._calls_made, 1))
        avg_latency  = (sum(self._latencies) / len(self._latencies)) if self._latencies else 0

        payload = {
            "agent_id":          self.agent_id,
            "name":              self.name,
            "department":        self.department,
            "status":            status or self._status,
            "current_task":      self._current_task,
            "model":             self.model,
            "tools":             self._tools,
            "recent_tool_calls": self._recent_tools[-10:],
            "metrics": {
                "tokens_input":  self._tokens_input,
                "tokens_output": self._tokens_output,
                "tokens_total":  total_tokens,
                "calls_made":    self._calls_made,
                "error_rate":    round(error_rate, 4),
                "avg_latency_ms":round(avg_latency, 1),
            },
        }
        if event:
            payload["event"]        = event
            payload["event_detail"] = event_detail or ""
        return payload

    def _normalize_tools(self, tools) -> List[str]:
        """Extract tool names from whatever format the framework uses."""
        result = []
        for t in tools:
            if isinstance(t, str):
                result.append(t)
            elif hasattr(t, "name"):
                result.append(t.name)
            elif isinstance(t, dict) and "name" in t:
                result.append(t["name"])
        return result

    def _discover_tools(self) -> List[str]:
        """Auto-discover functions decorated as tools in the calling module."""
        found = []
        frame = sys._getframe(2)
        module = sys.modules.get(frame.f_globals.get("__name__", ""), None)
        if module:
            for name, obj in inspect.getmembers(module):
                if callable(obj) and (
                    hasattr(obj, "_is_tool") or
                    hasattr(obj, "tool_name") or
                    getattr(obj, "__tool__", False)
                ):
                    found.append(name)
        return found

    def _post(self, path: str, data: Dict) -> Optional[Dict]:
        url = self.server_url + path
        try:
            if _HTTP_CLIENT == "httpx":
                r = httpx.post(url, json=data, timeout=5)
                return r.json() if r.status_code < 500 else None
            else:
                req = urllib.request.Request(
                    url,
                    data=_json.dumps(data).encode(),
                    headers={"Content-Type": "application/json"},
                    method="POST"
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    return _json.loads(resp.read())
        except Exception as e:
            logger.debug(f"[ControlTower] POST {path} failed: {e}")
            return None

    def _get(self, path: str) -> Optional[Dict]:
        url = self.server_url + path
        try:
            if _HTTP_CLIENT == "httpx":
                r = httpx.get(url, timeout=5)
                return r.json() if r.status_code < 500 else None
            else:
                with urllib.request.urlopen(url, timeout=5) as resp:
                    return _json.loads(resp.read())
        except Exception as e:
            logger.debug(f"[ControlTower] GET {path} failed: {e}")
            return None


# ── Convenience: async version ─────────────────────────────────────────────────

class AsyncControlTower(ControlTower):
    """Async-native version for agents running in an asyncio event loop."""

    def start_async(self, tools=None, get_status: Callable = None):
        if tools:
            self._tools = self._normalize_tools(tools)
        self._get_status_fn = get_status
        self._running = True
        asyncio.ensure_future(self._async_heartbeat_loop())
        return self

    async def _async_heartbeat_loop(self):
        while self._running:
            try:
                payload = self._build_payload()
                await self._async_post("/api/heartbeat", payload)
                self._tokens_input = self._tokens_output = self._calls_made = 0
                self._error_count  = 0
                self._recent_tools = []
            except Exception as e:
                logger.debug(f"[ControlTower] Async heartbeat error: {e}")
            await asyncio.sleep(self.interval)

    async def _async_post(self, path: str, data: Dict):
        import httpx
        async with httpx.AsyncClient() as client:
            try:
                await client.post(self.server_url + path, json=data, timeout=5)
            except Exception as e:
                logger.debug(f"[ControlTower] Async POST {path} failed: {e}")

    async def track_async(self, coro):
        """Await a coroutine and auto-capture token usage."""
        response = await coro
        return self.track(response)

    async def escalate_async(self, question: str, context: str = "",
                              urgency: str = "normal") -> str:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.escalate, question, context, urgency)

    async def wait_for_decision_async(self, escalation_id: str,
                                       poll_interval: int = 5) -> str:
        import httpx
        while True:
            async with httpx.AsyncClient() as client:
                try:
                    r = await client.get(
                        f"{self.server_url}/api/escalations/{escalation_id}", timeout=5
                    )
                    data = r.json()
                    if data.get("status") in ("resolved", "on_hold"):
                        return data.get("decision", "unknown")
                except Exception:
                    pass
            await asyncio.sleep(poll_interval)
