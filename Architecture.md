# Architecture Ground Rules

## 1. Modular Domain-Driven Design

The codebase is organized by **domain**, not by technical layer. Each domain module owns its models, interfaces, and implementations.

```
src/
  modules/
    canvas/        # viewport, layout, connections
    nodes/         # node types, capabilities, rendering
    chat/          # agent, messages, tool dispatch
    generation/    # LLM calls, image generation
    session/       # persistence, save/restore
  shared/          # cross-cutting contracts (interfaces, types)
``` 
(The above is just an example structure)

A domain module **never** reaches into another module's internals. All cross-module communication goes through exported interfaces.

## 2. Contracts First — Interfaces Over Implementations

All business logic is defined as **interfaces** before any implementation is written.

```ts
// Define the contract in the shared module
interface ImageGenerator {
  generate(prompt: string, format: ImageFormat): Promise<GenerationResult>;
}

// Implement separately in the respective module
class GeminiImageGenerator implements ImageGenerator { ... }
```

- Every service, repository, and use-case exposes an interface.
- Consumers depend on the interface, never the concrete class.
- This applies to node capabilities too: `EditableField`, `NodeAction`, and `ChatTool` are contracts that node types implement.

## 3. Data Classes — Controlled Access

Domain data is encapsulated in **data classes** with private fields. Public methods return data in the format the caller actually needs — no leaking internal structure.

```ts
class CampaignSettings {
  private objectives: Objective[];
  private budget: number;
  private currency: Currency;

  // Returns what the UI needs, not the raw internals
  formattedBudget(): string {
    return `${this.currency.symbol}${this.budget.toLocaleString()}`;
  }

  objectivesByGroup(): Record<'b2c' | 'b2b', Objective[]> {
    return groupBy(this.objectives, o => o.type);
  }
}
```

- Fields are **private** by default.
- Expose purpose-specific accessors, not generic getters.
- If a caller needs data in a particular shape, the data class provides a method for that shape.

## 4. Dependency Injection

All dependencies are **injected**, never instantiated inline.

```ts
// Good — dependency is injected
class BriefGenerationService {
  constructor(
    private readonly llm: LLMClient,
    private readonly brandContext: BrandContextProvider
  ) {}
}

// Bad — hardcoded dependency
class BriefGenerationService {
  private llm = new GeminiClient();
}
```

- Use constructor injection as the default.
- A composition root (or DI container) wires everything together at app startup.
- This makes every component testable in isolation — swap real services for test doubles via the same interface.

## 5. Summary of Non-Negotiables

| Rule | Rationale |
|------|-----------|
| Organize by domain, not by layer | Keeps related logic cohesive and modules independently evolvable |
| Define interfaces before implementations | Decouples consumers from providers; enables substitution |
| Private fields + purpose-built accessors | Prevents callers from depending on internal data shapes |
| Inject all dependencies | Makes code testable, swappable, and explicit about what it needs |
| No cross-domain internal imports | Enforces module boundaries; domains communicate through contracts |
