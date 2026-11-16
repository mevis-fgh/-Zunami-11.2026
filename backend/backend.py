"""
God Eye v4.0 — GraphQL Coverage Proxy (Absolute God Mode)
Запуск: python backend.py
Открыть: http://localhost:8000
"""
import os
from pathlib import Path
import hashlib
import asyncio
import json
import time
import random
from datetime import datetime
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Request, Depends, WebSocket, WebSocketDisconnect, Header
from fastapi.responses import JSONResponse, FileResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import (create_engine, String, Integer, DateTime, Text,
                        ForeignKey, JSON, UniqueConstraint, select, func, desc)
from sqlalchemy.orm import (sessionmaker, DeclarativeBase, Mapped,
                            mapped_column, Session)
from graphql import (build_schema, parse, GraphQLSchema, TypeInfo,
                     TypeInfoVisitor, Visitor, visit, validate, specified_rules,
                     get_introspection_query, build_client_schema,
                     GraphQLError)
from graphql.language import ast as gql_ast

# ============ CONFIG ============
GRAPHQL_TARGET_URL = os.getenv("GRAPHQL_TARGET_URL", "").strip()  # пусто = mock-режим
BASE_DIR = Path(__file__).resolve().parent  # БД и фронт ищем рядом с backend.py, а не в текущей папке
DATABASE_URL = f"sqlite:///{(BASE_DIR / 'coverage.db').as_posix()}"
MOCK_MODE = not GRAPHQL_TARGET_URL

SCHEMA_SDL = """
type Query {
  user(id: ID!): User
  users: [User!]!
  post(id: ID!): Post
  posts: [Post!]!
  search(query: String!): [SearchResult!]!
}
type Mutation {
  createUser(name: String!, email: String): User
  createPost(title: String!, body: String, authorId: ID!): Post
  deletePost(id: ID!): Boolean!
}
type User {
  id: ID!
  name: String!
  email: String
  posts: [Post!]!
  friends: [User!]!
}
type Post {
  id: ID!
  title: String!
  body: String
  author: User!
  comments: [Comment!]!
}
type Comment {
  id: ID!
  text: String!
  author: User!
}
union SearchResult = User | Post
"""

# ============ DB ============
engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)

class Base(DeclarativeBase):
    pass

class SchemaSnapshot(Base):
    __tablename__ = "schema_snapshots"
    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    hash: Mapped[str] = mapped_column(String(64), index=True)
    raw: Mapped[dict] = mapped_column(JSON)

class Run(Base):
    __tablename__ = "runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_key: Mapped[str] = mapped_column(String(128), index=True)
    branch: Mapped[str | None] = mapped_column(String(128), nullable=True)
    team: Mapped[str | None] = mapped_column(String(128), nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    schema_snapshot_id: Mapped[int] = mapped_column(ForeignKey("schema_snapshots.id"))

class ExecutionLog(Base):
    __tablename__ = "execution_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    operation_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    operation_type: Mapped[str] = mapped_column(String(16))
    query_text: Mapped[str] = mapped_column(Text)
    test_id: Mapped[str | None] = mapped_column(String(256), nullable=True)
    status_code: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class FieldHit(Base):
    __tablename__ = "field_hits"
    __table_args__ = (UniqueConstraint("run_id", "type_name", "field_name", name="uq_field_hit"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    type_name: Mapped[str] = mapped_column(String(256), index=True)
    field_name: Mapped[str] = mapped_column(String(256), index=True)
    hits: Mapped[int] = mapped_column(Integer, default=0)

class TypeHit(Base):
    __tablename__ = "type_hits"
    __table_args__ = (UniqueConstraint("run_id", "type_name", name="uq_type_hit"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    type_name: Mapped[str] = mapped_column(String(256), index=True)
    hits: Mapped[int] = mapped_column(Integer, default=0)

class TestCaseHit(Base):
    __tablename__ = "test_case_hits"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id"), index=True)
    test_id: Mapped[str] = mapped_column(String(256), index=True)
    type_name: Mapped[str] = mapped_column(String(256))
    field_name: Mapped[str] = mapped_column(String(256))

Base.metadata.create_all(bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ============ EVENT BUS ============
class EventBus:
    def __init__(self):
        self._clients: set = set()
        self._lock = asyncio.Lock()
    async def connect(self, ws):
        async with self._lock: self._clients.add(ws)
    async def disconnect(self, ws):
        async with self._lock: self._clients.discard(ws)
    async def broadcast(self, event: str, payload: Any):
        msg = json.dumps({"event": event, "payload": payload})
        dead = []
        for ws in list(self._clients):
            try: await ws.send_text(msg)
            except Exception: dead.append(ws)
        for ws in dead: await self.disconnect(ws)

bus = EventBus()

# ============ RUNTIME ============
_CACHE = {"schema": None, "graph": None, "run_id": None}

def load_schema() -> GraphQLSchema:
    return build_schema(SCHEMA_SDL)

def build_internal_graph(schema: GraphQLSchema) -> dict:
    graph = {"types": {}, "edges": []}
    for tname, gtype in schema.type_map.items():
        if tname.startswith("__"):
            continue
        fields = getattr(gtype, "fields", None)
        if fields is None:
            continue
        graph["types"][tname] = {"fields": {}}
        for fname, fdef in fields.items():
            t = fdef.type
            while hasattr(t, "of_type"):
                t = t.of_type
            graph["types"][tname]["fields"][fname] = {"type": t.name, "args": list(fdef.args.keys())}
            if hasattr(t, "fields"):
                graph["edges"].append({"from": tname, "field": fname, "to": t.name})
    return graph

def bootstrap(db: Session) -> int:
    schema = load_schema()
    h = hashlib.sha256(SCHEMA_SDL.encode()).hexdigest()
    snap = db.scalar(select(SchemaSnapshot).where(SchemaSnapshot.hash == h))
    if not snap:
        snap = SchemaSnapshot(hash=h, raw={"sdl_preview": SCHEMA_SDL[:200]})
        db.add(snap); db.flush()
    run = db.scalars(select(Run).order_by(Run.id.desc()).limit(1)).first()
    if run is not None and not db.scalar(
            select(func.count(ExecutionLog.id)).where(ExecutionLog.run_id == run.id)):
        run.schema_snapshot_id = snap.id  # последний прогон пустой — переиспользуем
        db.commit()
    else:
        run = Run(run_key=f"run-{int(datetime.utcnow().timestamp())}",
                  branch="main", team="demo", schema_snapshot_id=snap.id)
        db.add(run); db.commit()
    _CACHE.update(schema=schema, graph=build_internal_graph(schema), run_id=run.id)
    return run.id

def get_schema(db):
    if _CACHE["schema"] is None: bootstrap(db)
    return _CACHE["schema"]

def get_graph(db):
    if _CACHE["graph"] is None: get_schema(db)
    return _CACHE["graph"]

def get_run_id(db):
    if _CACHE["run_id"] is None: get_schema(db)
    return _CACHE["run_id"]

def set_active_run(run_id: int):
    _CACHE["run_id"] = run_id

# ============ ANALYZER ============
def analyze_query(query_text: str, schema: GraphQLSchema, strict: bool = False) -> dict:
    """Разбирает запрос. При strict=True валидирует и падает при ошибке."""
    doc = parse(query_text)
    if strict:
        errors = validate(schema, doc, rules=specified_rules)
        if errors:
            raise GraphQLError("; ".join(str(e) for e in errors))
    ti = TypeInfo(schema)
    types: dict[str, int] = {}
    fields: dict[tuple[str, str], int] = {}
    warnings = []

    class V(Visitor):
        def enter_field(self, node, *a):
            if node.name.value.startswith("__"):
                return  # __typename / __schema — служебные, в покрытие не считаем
            parent, fd = ti.get_parent_type(), ti.get_field_def()
            if parent and fd:
                types[parent.name] = types.get(parent.name, 0) + 1
                fname = node.name.value
                fields[(parent.name, fname)] = fields.get((parent.name, fname), 0) + 1
            else:
                # поле не найдено в схеме — предупреждение, но не падаем
                pname = parent.name if parent else "?"
                warnings.append(f"unknown field '{node.name.value}' on {pname}")

        def enter_inline_fragment(self, node, *a):
            t = ti.get_type()
            if t and hasattr(t, "name"):
                types[t.name] = types.get(t.name, 0) + 1

    visit(doc, TypeInfoVisitor(ti, V()))
    ops = [d for d in doc.definitions if isinstance(d, gql_ast.OperationDefinitionNode)]
    op_type, op_name = "query", None
    if ops:
        op_type = ops[0].operation.value
        op_name = ops[0].name.value if ops[0].name else None
    return {"operation_type": op_type, "operation_name": op_name,
            "types": types, "fields": fields, "warnings": warnings}

def record_hits(db: Session, run_id: int, analysis: dict, test_id: str | None = None):
    deltas = []
    for tname, cnt in analysis["types"].items():
        row = db.scalar(select(TypeHit).where(TypeHit.run_id == run_id, TypeHit.type_name == tname))
        if row: row.hits += cnt
        else: db.add(TypeHit(run_id=run_id, type_name=tname, hits=cnt))
        deltas.append({"type": tname, "hits": cnt, "kind": "type"})
    for (tname, fname), cnt in analysis["fields"].items():
        row = db.scalar(select(FieldHit).where(
            FieldHit.run_id == run_id, FieldHit.type_name == tname, FieldHit.field_name == fname))
        if row: row.hits += cnt
        else: db.add(FieldHit(run_id=run_id, type_name=tname, field_name=fname, hits=cnt))
        deltas.append({"type": tname, "field": fname, "hits": cnt, "kind": "field"})
        if test_id:
            db.add(TestCaseHit(run_id=run_id, test_id=test_id, type_name=tname, field_name=fname))
    db.commit()
    return deltas

# ============ MOCK DATA (для mock-режима) ============
def mock_response(query_text: str, analysis: dict) -> dict:
    """Генерирует правдоподобный ответ для запроса, чтобы фронт не падал."""
    data = {}
    for (tname, fname) in analysis["fields"].keys():
        if tname == "Query" or tname == "Mutation":
            key = fname
            if fname in ("users", "posts", "search"):
                data[key] = [_mock_entity(analysis, "User" if "user" in fname else "Post") for _ in range(3)]
            elif fname in ("user", "post"):
                data[key] = _mock_entity(analysis, "User" if fname == "user" else "Post")
            elif fname == "createUser":
                data[key] = {"id": "1", "name": "Alice", "email": "alice@example.com"}
            elif fname == "createPost":
                data[key] = {"id": "1", "title": "Hello", "body": "World"}
            elif fname == "deletePost":
                data[key] = True
    return {"data": data, "_mock": True}

def _mock_entity(analysis: dict, tname: str) -> dict:
    obj = {"id": "1"}
    for (pt, pf) in analysis["fields"].keys():
        if pt == tname:
            if pf == "name": obj["name"] = "John Doe"
            elif pf == "email": obj["email"] = "john@example.com"
            elif pf == "title": obj["title"] = "Sample Post"
            elif pf == "body": obj["body"] = "Lorem ipsum"
            elif pf in ("posts", "comments", "friends"): obj[pf] = []
            elif pf == "author": obj["author"] = {"id": "2", "name": "Jane"}
    return obj

# ============ APP ============
@asynccontextmanager
async def lifespan(app: FastAPI):
    db = SessionLocal()
    try:
        bootstrap(db)
        # self-test при старте
        schema = get_schema(db)
        analyze_query("{ users { id name } }", schema, strict=True)
        print(f"[god-eye] OK · mock_mode={MOCK_MODE} · run_id={_CACHE['run_id']}")
    except Exception as e:
        import traceback; traceback.print_exc()
        print(f"[god-eye] startup self-test failed: {type(e).__name__}: {e}")
    finally:
        db.close()
    yield

app = FastAPI(title="God Eye v4.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.get("/")
def root():
    return FileResponse(BASE_DIR / "frontend.html")

@app.get("/health")
def health():
    return {"status": "ok", "version": "4.0", "mode": "mock" if MOCK_MODE else "proxy"}

async def forward(query_text: str, variables, analysis: dict):
    """Выполняет запрос: mock или реальный upstream. Возвращает (data, status)."""
    if MOCK_MODE:
        return mock_response(query_text, analysis), 200
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            up = await client.post(GRAPHQL_TARGET_URL,
                                   json={"query": query_text, "variables": variables or {}})
        return up.json(), up.status_code
    except Exception as e:
        return {"errors": [{"message": f"upstream unreachable: {type(e).__name__}: {e}"}]}, 502

@app.get("/api/selftest")
def selftest(db: Session = Depends(get_db)):
    """Открой http://localhost:8000/api/selftest — покажет, работает ли разбор запросов."""
    import traceback, graphql as g
    out = {"graphql_core": g.__version__, "mock_mode": MOCK_MODE,
           "db": DATABASE_URL, "run_id": get_run_id(db)}
    try:
        a = analyze_query("{ users { id name } }", get_schema(db), strict=True)
        out["analyze"] = "ok"
        out["fields"] = [f"{t}.{f}" for (t, f) in a["fields"]]
    except Exception:
        out["analyze"] = "FAILED"
        out["traceback"] = traceback.format_exc()
    return out

# --- PROXY ---
@app.post("/graphql")
async def graphql_proxy(request: Request, db: Session = Depends(get_db),
                        x_test_id: str | None = Header(default=None, alias="X-Test-Id")):
    body = await request.body()
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse({"errors": [{"message": "invalid JSON"}]}, status_code=400)

    if not isinstance(payload, dict):
        return JSONResponse({"errors": [{"message": "batched requests not supported"}]}, status_code=400)
    run_id = get_run_id(db)
    schema = get_schema(db)
    query_text = payload.get("query") or ""
    analysis = None

    t0 = time.time()
    op_name, op_type = None, "query"
    warnings = []
    if query_text:
        try:
            analysis = analyze_query(query_text, schema, strict=False)
            op_type, op_name = analysis["operation_type"], analysis["operation_name"]
            warnings = analysis.get("warnings", [])
            deltas = record_hits(db, run_id, analysis, test_id=x_test_id)
            await bus.broadcast("coverage_delta", {
                "run_id": run_id, "deltas": deltas,
                "operation": op_name or "anonymous", "operation_type": op_type, "test_id": x_test_id,
            })
        except Exception as e:
            analysis = None
            warnings = [f"parse error: {e}"]

    # Получаем ответ: от upstream или мок
    if MOCK_MODE or not GRAPHQL_TARGET_URL:
        response_data = mock_response(query_text, analysis) if analysis else {"errors": [{"message": "parse failed"}]}
        status = 200 if analysis else 400
    else:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                upstream = await client.post(GRAPHQL_TARGET_URL, content=body,
                                             headers={"Content-Type": "application/json"})
            response_data = upstream.json()
            status = upstream.status_code
        except Exception as e:
            response_data = {"errors": [{"message": f"upstream unreachable: {e}"}]}
            status = 502

    duration = int((time.time() - t0) * 1000)
    db.add(ExecutionLog(run_id=run_id, operation_name=op_name, operation_type=op_type,
                        query_text=query_text, test_id=x_test_id,
                        status_code=status, duration_ms=duration))
    db.commit()
    if warnings:
        response_data["_warnings"] = warnings
    return JSONResponse(content=response_data, status_code=status)

# --- SCHEMA ---
@app.get("/api/schema/graph")
def schema_graph(db: Session = Depends(get_db)):
    return get_graph(db)

# --- COVERAGE ---
@app.get("/api/coverage/summary")
def summary(run_id: int | None = None, db: Session = Depends(get_db)):
    rid = run_id or get_run_id(db)
    graph = get_graph(db)
    total_fields = sum(len(t["fields"]) for t in graph["types"].values())
    total_types = len(graph["types"])
    covered = db.scalar(select(func.count(FieldHit.id)).where(FieldHit.run_id == rid, FieldHit.hits > 0)) or 0
    covered_types = db.scalar(select(func.count(TypeHit.id)).where(TypeHit.run_id == rid, TypeHit.hits > 0)) or 0
    return {"run_id": rid, "types_total": total_types, "types_covered": covered_types,
            "fields_total": total_fields, "fields_covered": covered,
            "coverage_pct": round(covered / total_fields * 100, 2) if total_fields else 0.0,
            "types_pct": round(covered_types / total_types * 100, 2) if total_types else 0.0,
            "mock_mode": MOCK_MODE}

@app.get("/api/coverage/fields")
def fields(only_uncovered: bool = False, run_id: int | None = None,
           operation: str | None = None, q: str | None = None,
           db: Session = Depends(get_db)):
    rid = run_id or get_run_id(db)
    graph = get_graph(db)
    rows = db.execute(select(FieldHit.type_name, FieldHit.field_name, FieldHit.hits)
                      .where(FieldHit.run_id == rid)).all()
    hit = {(t, f): h for t, f, h in rows}

    # собираем поля, встречавшиеся в запросах нужного типа
    allowed = None
    if operation and operation in ("query", "mutation", "subscription"):
        logs = db.execute(select(ExecutionLog.query_text).where(
            ExecutionLog.run_id == rid, ExecutionLog.operation_type == operation)).all()
        allowed = set()
        for (qt,) in logs:
            if not qt: continue
            try:
                a = analyze_query(qt, get_schema(db), strict=False)
                for k in a["fields"].keys(): allowed.add(k)
            except Exception: pass

    out = []
    for tname, t in graph["types"].items():
        for fname, finfo in t["fields"].items():
            if allowed is not None and (tname, fname) not in allowed: continue
            h = hit.get((tname, fname), 0)
            if only_uncovered and h > 0: continue
            if q and q.lower() not in f"{tname}.{fname}".lower(): continue
            out.append({"type": tname, "field": fname, "hits": h, "covered": h > 0,
                        "field_type": finfo["type"]})
    out.sort(key=lambda x: (-x["hits"], x["type"], x["field"]))
    return out

@app.get("/api/coverage/hot")
def hot(limit: int = 10, run_id: int | None = None, db: Session = Depends(get_db)):
    rid = run_id or get_run_id(db)
    rows = db.execute(select(FieldHit.type_name, FieldHit.field_name, FieldHit.hits)
                      .where(FieldHit.run_id == rid)
                      .order_by(desc(FieldHit.hits)).limit(limit)).all()
    return [{"type": t, "field": f, "hits": h} for t, f, h in rows]

@app.get("/api/coverage/field/{type_name}/{field_name}/queries")
def field_queries(type_name: str, field_name: str, run_id: int | None = None,
                  limit: int = 20, db: Session = Depends(get_db)):
    rid = run_id or get_run_id(db)
    schema = get_schema(db)
    logs, seen = [], set()
    rows = db.scalars(select(ExecutionLog).where(ExecutionLog.run_id == rid)
                      .order_by(desc(ExecutionLog.id)).limit(500)).all()
    for log in rows:
        if not log.query_text or log.query_text in seen:
            continue
        try:
            a = analyze_query(log.query_text, schema, strict=False)
        except Exception:
            continue
        if (type_name, field_name) in a["fields"]:
            seen.add(log.query_text)
            logs.append({"test_id": log.test_id, "operation": log.operation_name,
                         "type": log.operation_type, "status": log.status_code,
                         "duration_ms": log.duration_ms, "query": log.query_text[:2000]})
            if len(logs) >= limit:
                break
    return {"type": type_name, "field": field_name, "queries": logs}

# --- HISTORY ---
@app.get("/api/history")
def history(limit: int = 50, run_id: int | None = None, db: Session = Depends(get_db)):
    rid = run_id or get_run_id(db)
    rows = db.execute(select(ExecutionLog).where(ExecutionLog.run_id == rid)
                      .order_by(desc(ExecutionLog.id)).limit(limit)).all()
    return [{"id": log.id, "run_id": log.run_id, "operation": log.operation_name,
             "type": log.operation_type, "status": log.status_code,
             "duration_ms": log.duration_ms, "query": log.query_text[:2000],
             "created_at": log.created_at.isoformat()}
            for (log,) in rows]

# --- RUNS ---
@app.get("/api/runs")
def list_runs(db: Session = Depends(get_db)):
    rows = db.scalars(select(Run).order_by(Run.started_at.desc()).limit(100)).all()
    out = []
    graph = get_graph(db)
    total = sum(len(t["fields"]) for t in graph["types"].values())
    for r in rows:
        covered = db.scalar(select(func.count(FieldHit.id)).where(
            FieldHit.run_id == r.id, FieldHit.hits > 0)) or 0
        pct = round(covered / total * 100, 2) if total else 0
        out.append({"id": r.id, "run_key": r.run_key, "branch": r.branch,
                    "team": r.team, "started_at": r.started_at.isoformat(),
                    "fields_covered": covered, "coverage_pct": pct})
    return out

@app.post("/api/runs/new")
def new_run(payload: dict = None, db: Session = Depends(get_db)):
    payload = payload or {}
    snap = db.scalar(select(SchemaSnapshot).limit(1))
    run = Run(run_key=payload.get("run_key", f"run-{int(datetime.utcnow().timestamp())}"),
              branch=payload.get("branch", "manual"), team=payload.get("team", "manual"),
              schema_snapshot_id=snap.id)
    db.add(run); db.commit()
    set_active_run(run.id)
    return {"run_id": run.id}

@app.post("/api/runs/{run_id}/activate")
def activate(run_id: int):
    set_active_run(run_id)
    return {"active": run_id}

@app.post("/api/runs/{run_id}/reset")
def reset_run(run_id: int, db: Session = Depends(get_db)):
    """Сбрасывает покрытие прогона (удобно для повторных тестов)."""
    db.query(FieldHit).filter(FieldHit.run_id == run_id).delete()
    db.query(TypeHit).filter(TypeHit.run_id == run_id).delete()
    db.query(TestCaseHit).filter(TestCaseHit.run_id == run_id).delete()
    db.query(ExecutionLog).filter(ExecutionLog.run_id == run_id).delete()
    db.commit()
    return {"ok": True, "run_id": run_id}

# --- DIFF ---
@app.get("/api/diff")
def diff(a: int, b: int, db: Session = Depends(get_db)):
    graph = get_graph(db)
    ra = {(t, f): h for t, f, h in db.execute(
        select(FieldHit.type_name, FieldHit.field_name, FieldHit.hits)
        .where(FieldHit.run_id == a)).all()}
    rb = {(t, f): h for t, f, h in db.execute(
        select(FieldHit.type_name, FieldHit.field_name, FieldHit.hits)
        .where(FieldHit.run_id == b)).all()}
    out = []
    for tname, t in graph["types"].items():
        for fname in t["fields"]:
            ha, hb = ra.get((tname, fname), 0), rb.get((tname, fname), 0)
            out.append({"type": tname, "field": fname, "a": ha, "b": hb, "delta": hb - ha})
    out.sort(key=lambda x: -abs(x["delta"]))
    total_fields = sum(len(t["fields"]) for t in graph["types"].values())
    total_a = sum(1 for v in ra.values() if v > 0)
    total_b = sum(1 for v in rb.values() if v > 0)
    return {"a": {"run": a, "covered": total_a, "pct": round(total_a/total_fields*100, 2) if total_fields else 0},
            "b": {"run": b, "covered": total_b, "pct": round(total_b/total_fields*100, 2) if total_fields else 0},
            "delta_fields": out}

# --- EXPORT ---
@app.get("/api/export")
def export(fmt: str = "json", run_id: int | None = None, db: Session = Depends(get_db)):
    rid = run_id or get_run_id(db)
    graph = get_graph(db)
    ra = {(t, f): h for t, f, h in db.execute(
        select(FieldHit.type_name, FieldHit.field_name, FieldHit.hits)
        .where(FieldHit.run_id == rid)).all()}
    rows = []
    for tname, t in graph["types"].items():
        for fname, finfo in t["fields"].items():
            rows.append({"run_id": rid, "type": tname, "field": fname,
                         "field_type": finfo["type"], "hits": ra.get((tname, fname), 0)})
    if fmt == "csv":
        import io, csv
        buf = io.StringIO()
        if rows:
            w = csv.DictWriter(buf, fieldnames=rows[0].keys())
            w.writeheader(); w.writerows(rows)
        return Response(content=buf.getvalue(), media_type="text/csv",
                        headers={"Content-Disposition": f"attachment; filename=coverage_run_{rid}.csv"})
    return Response(content=json.dumps(rows, indent=2), media_type="application/json",
                    headers={"Content-Disposition": f"attachment; filename=coverage_run_{rid}.json"})

# --- SEND QUERY (from UI) ---
@app.post("/api/send-query")
async def send_query(payload: dict, db: Session = Depends(get_db)):
    query_text = (payload.get("query") or "").strip()
    if not query_text:
        return {"ok": False, "error": "empty query"}
    schema = get_schema(db)
    run_id = get_run_id(db)
    try:
        analysis = analyze_query(query_text, schema, strict=False)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if analysis.get("warnings"):
        return {"ok": False, "error": "; ".join(analysis["warnings"][:3])}

    t0 = time.time()
    response, status = await forward(query_text, payload.get("variables"), analysis)
    duration = int((time.time() - t0) * 1000)

    deltas = record_hits(db, run_id, analysis, test_id="ui-manual")
    db.add(ExecutionLog(run_id=run_id, operation_name=analysis["operation_name"],
                        operation_type=analysis["operation_type"], query_text=query_text,
                        test_id="ui-manual", status_code=status, duration_ms=duration))
    db.commit()
    await bus.broadcast("coverage_delta", {
        "run_id": run_id, "deltas": deltas,
        "operation": analysis["operation_name"] or "anonymous",
        "operation_type": analysis["operation_type"], "test_id": "ui-manual",
    })
    return {"ok": status < 400, "status": status, "response": response,
            "error": None if status < 400 else f"upstream status {status}",
            "analysis": {
                "operation_type": analysis["operation_type"],
                "operation_name": analysis["operation_name"],
                "types": list(analysis["types"].keys()),
                "fields": [f"{t}.{f}" for (t, f) in analysis["fields"].keys()],
            }}

# --- DEMO ---
DEMO_QUERIES = [
    ('query GetUsers { users { id name email } }', 'test-users'),
    ('query GetPosts { posts { id title author { name } } }', 'test-posts'),
    ('query NestedPosts { users { posts { title body } } }', 'test-nested'),
    ('mutation CreateUser { createUser(name: "Alice", email: "a@b.c") { id name } }', 'test-create'),
    ('query Search { search(query: "hello") { ... on User { name } ... on Post { title } } }', 'test-search'),
    ('query PostComments { post(id: 1) { title comments { text author { name } } } }', 'test-comments'),
    ('query UserFriends { user(id: 1) { friends { name posts { title } } } }', 'test-friends'),
]

@app.post("/api/demo")
async def demo(db: Session = Depends(get_db)):
    run_id = get_run_id(db)
    schema = get_schema(db)
    processed = 0
    for q, tid in DEMO_QUERIES:
        try:
            analysis = analyze_query(q, schema, strict=False)
            deltas = record_hits(db, run_id, analysis, test_id=tid)
            db.add(ExecutionLog(run_id=run_id, operation_name=analysis["operation_name"],
                                operation_type=analysis["operation_type"], query_text=q,
                                test_id=tid, status_code=200,
                                duration_ms=random.randint(10, 120)))
            await bus.broadcast("coverage_delta", {
                "run_id": run_id, "deltas": deltas,
                "operation": analysis["operation_name"] or "anonymous",
                "operation_type": analysis["operation_type"], "test_id": tid,
            })
            processed += 1
            await asyncio.sleep(0.15)  # чтобы было видно как оживает граф
        except Exception as e:
            print("demo error:", e)
    db.commit()
    return {"ok": True, "processed": processed}

# --- TIMELINE ---
@app.get("/api/timeline")
def timeline(db: Session = Depends(get_db)):
    """Возвращает историю покрытия по прогонам (для графика)."""
    graph = get_graph(db)
    total = sum(len(t["fields"]) for t in graph["types"].values())
    rows = list(reversed(db.scalars(select(Run).order_by(Run.id.desc()).limit(30)).all()))  # последние 30
    out = []
    for r in rows:
        covered = db.scalar(select(func.count(FieldHit.id)).where(
            FieldHit.run_id == r.id, FieldHit.hits > 0)) or 0
        out.append({"run_id": r.id, "run_key": r.run_key,
                    "started_at": r.started_at.isoformat(),
                    "coverage_pct": round(covered / total * 100, 2) if total else 0,
                    "covered": covered, "total": total})
    return out

# --- WEBSOCKET ---
@app.websocket("/api/ws/coverage")
async def ws_coverage(ws: WebSocket):
    await ws.accept()
    await bus.connect(ws)
    try:
        while True: await ws.receive_text()
    except WebSocketDisconnect:
        await bus.disconnect(ws)

if __name__ == "__main__":
    import socket
    import uvicorn

    def _free(port: int) -> bool:
        with socket.socket() as s:
            return s.connect_ex(("127.0.0.1", port)) != 0  # не отвечает — порт свободен

    port = next((p for p in range(8000, 8020) if _free(p)), 8000)
    if port != 8000:
        print(f"[god-eye] порт 8000 занят (там работает старый сервер) — использую {port}")
    print(f"[god-eye] ОТКРОЙ: http://localhost:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port)