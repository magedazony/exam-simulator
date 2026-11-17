"""
Fill English translations for starter-drafts-docx2.xlsx
All translations are manually verified PMP terminology.
"""
import openpyxl

TRANSLATIONS = [
    # Q1
    {
        "stem": "You are a project manager in an Agile environment. The team is complaining about many impediments blocking their work, and they need someone to help them work smoothly without direct commands. What is the best leadership style to use?",
        "optionA": "Transactional",
        "optionB": "Laissez-faire",
        "optionC": "Servant Leader",
        "optionD": "Charismatic",
        "whyCorrect": "In Agile, the leader's role is to empower the team, remove impediments, and serve the team rather than issue directives. Transactional works for purely operational work; Laissez-faire can leave a team that still needs support adrift; Charismatic is not the primary solution for impediment removal.",
        "taskCode": "1.1", "mindset": "agile",
        "keyConcept": "Servant Leadership", "learningObjective": "Select appropriate leadership style in Agile context",
    },
    # Q2
    {
        "stem": "The organization has a new strategy and wants to ensure the current project is aligned with it. Who takes the primary step to ensure alignment with organizational strategy?",
        "optionA": "Project Team only",
        "optionB": "Project Sponsor in collaboration with the Project Manager",
        "optionC": "Customer only",
        "optionD": "PMO only",
        "whyCorrect": "Integration here is twofold, beginning with understanding strategic goals together with the Sponsor and ensuring alignment — which is the clear role of the PM working with the Sponsor.",
        "taskCode": "1.2", "mindset": "predictive",
        "keyConcept": "Strategic Alignment", "learningObjective": "Identify stakeholders responsible for strategic alignment",
    },
    # Q3
    {
        "stem": "Your large project involves many parties (Vendors + Internal Departments). Conflicting decisions have started to occur, each team is executing in its own way, and the project is heading toward failure. What is the best first action as a Project Manager?",
        "optionA": "Increase detailed reporting daily",
        "optionB": "Identify and implement integration mechanisms and align teams on processes",
        "optionC": "Ask sponsor to replace department heads",
        "optionD": "Freeze scope immediately",
        "whyCorrect": "The root problem is lack of integration. The PM must integrate processes, connect the work, and create a unified execution method. This is the essence of integration failure reducing the chances of achieving objectives.",
        "taskCode": "1.3", "mindset": "hybrid",
        "keyConcept": "Project Integration Management", "learningObjective": "Apply integration mechanisms to resolve coordination failures",
    },
    # Q4
    {
        "stem": "During the exam you encounter a question asking you to 'select two correct answers,' but you selected only one. What is the most likely outcome?",
        "optionA": "The system will accept it as a complete answer",
        "optionB": "You may receive partial credit",
        "optionC": "It will likely be counted as incorrect (because multiple correct answers are required)",
        "optionD": "It will automatically be converted to a single-choice question",
        "whyCorrect": "For Multiple Correct questions, you must select the required number of answers. Selecting fewer than required will generally be scored as incorrect.",
        "taskCode": "1.4", "mindset": "predictive",
        "keyConcept": "PMP Exam Format", "learningObjective": "Understand PMP exam question types and scoring rules",
    },
    # Q5
    {
        "stem": "During execution, a large change appeared that will heavily impact the budget, and your authority as PM does not cover it. What is the correct first action?",
        "optionA": "Implement the change immediately to save time",
        "optionB": "Escalate the change for review/approval above PM authority",
        "optionC": "Reject the change and continue with the plan",
        "optionD": "Ask the team to find a workaround without informing anyone",
        "whyCorrect": "Part of Governance Components is reviewing and approving changes that exceed the PM's authority. Escalation to the appropriate governance body is required.",
        "taskCode": "1.5", "mindset": "predictive",
        "keyConcept": "Change Control / Governance", "learningObjective": "Apply escalation procedures for changes beyond PM authority",
    },
    # Q6
    {
        "stem": "Stakeholders are complaining that there are too many meetings, committees, and approvals, and the project has become slow. What is the correct statement about project governance?",
        "optionA": "Governance should always be maximum",
        "optionB": "Governance should always be minimal",
        "optionC": "Balance—too much annoys, too little reduces engagement/accountability",
        "optionD": "Governance is only for finance",
        "whyCorrect": "Excessive governance annoys stakeholders; insufficient governance weakens participation and accountability. Balance is essential.",
        "taskCode": "1.5", "mindset": "hybrid",
        "keyConcept": "Project Governance", "learningObjective": "Explain the role of balanced governance in project management",
    },
    # Q7
    {
        "stem": "You work in a large organization and need a quick decision on a change that will affect multiple departments. Who is primarily responsible for this governance decision?",
        "optionA": "Team Lead",
        "optionB": "Steering Committee / Project Board",
        "optionC": "End users",
        "optionD": "Vendor manager",
        "whyCorrect": "The Governance Board (Steering Committee) exists to oversee, review, and decide on significant cross-departmental changes.",
        "taskCode": "1.5", "mindset": "predictive",
        "keyConcept": "Steering Committee", "learningObjective": "Identify governance decision-making bodies",
    },
    # Q8
    {
        "stem": "In a Phase Gate review (Predictive), management asks: 'Do we continue? Modify? Or terminate?' What is this decision point called?",
        "optionA": "Daily Standup",
        "optionB": "Tollgate / Kill point",
        "optionC": "Sprint Review",
        "optionD": "WBS Dictionary",
        "whyCorrect": "Phase Gates have synonymous names: Governance gate / Kill point / Tollgate / Phase review. All mean the same end-of-phase decision checkpoint.",
        "taskCode": "1.5", "mindset": "predictive",
        "keyConcept": "Phase Gate / Tollgate", "learningObjective": "Identify phase gate review terminology and purpose",
    },
    # Q9
    {
        "stem": "You are at the end of a Predictive project phase and discover the requirements have changed drastically, making the original plan impossible to execute. What is the best action?",
        "optionA": "Continue to next phase as planned",
        "optionB": "Continue with modifications or terminate based on governance decision",
        "optionC": "Ignore changes and focus on schedule",
        "optionD": "Ask the team to do overtime without informing anyone",
        "whyCorrect": "At the Phase Gate the decision is: continue / modify / terminate. If requirements change fundamentally, the governance body decides whether to adapt or stop.",
        "taskCode": "1.5", "mindset": "predictive",
        "keyConcept": "Phase Gate Decision", "learningObjective": "Apply phase gate decision criteria",
    },
    # Q10
    {
        "stem": "Who is responsible for compliance of project activities, deliverable quality, and working with vendors?",
        "optionA": "PMO only",
        "optionB": "Sponsor only",
        "optionC": "Project team (with PMO oversight at organizational level)",
        "optionD": "Customer only",
        "whyCorrect": "The PMO monitors at the organizational level, but the team is responsible for compliance related to the project's specific activities and deliverables.",
        "taskCode": "2.1", "mindset": "predictive",
        "keyConcept": "Compliance Responsibility", "learningObjective": "Identify who is accountable for project-level compliance",
    },
    # Q11
    {
        "stem": "A project contains sensitive customer data. You are preparing your plan. Which compliance requirement is the most critical to address?",
        "optionA": "Work breakdown structure",
        "optionB": "Privacy laws + handling sensitive information",
        "optionC": "Float calculation",
        "optionD": "Team charter",
        "whyCorrect": "Compliance includes privacy laws and proper handling of sensitive information as a fundamental requirement.",
        "taskCode": "2.1", "mindset": "predictive",
        "keyConcept": "Data Privacy Compliance", "learningObjective": "Identify compliance requirements for projects with sensitive data",
    },
    # Q12
    {
        "stem": "Near the end of the project, you discovered late that some regulatory requirements were not met, which may lead to a legal risk. What should have been done?",
        "optionA": "Check compliance only after handover",
        "optionB": "Check compliance before the end of the project",
        "optionC": "Ignore, because sponsor is responsible",
        "optionD": "Focus only on schedule",
        "whyCorrect": "PMI is clear: compliance must be verified before project end to avoid late-stage legal risks.",
        "taskCode": "2.1", "mindset": "predictive",
        "keyConcept": "Pre-Closure Compliance Check", "learningObjective": "Explain when compliance verification should occur",
    },
    # Q13
    {
        "stem": "You are a project manager in a highly regulated industry. The company has periodic audits. What approach best ensures ongoing compliance?",
        "optionA": "Focus on schedule only",
        "optionB": "Documentation + Compliance audit + Council involvement",
        "optionC": "Avoid involving legal/technical people",
        "optionD": "Do compliance at the end only",
        "whyCorrect": "Best practices include documentation, compliance audits, and involving the compliance council with legal and technical specialists.",
        "taskCode": "2.1", "mindset": "predictive",
        "keyConcept": "Compliance Best Practices", "learningObjective": "Apply compliance best practices in regulated industries",
    },
    # Q14
    {
        "stem": "The customer requested a new feature that has security requirements. What is the first action?",
        "optionA": "Approve immediately to satisfy customer",
        "optionB": "Confirm compliance requirements and analyze consequences of non-compliance",
        "optionC": "Ask the team to implement quietly",
        "optionD": "Ignore because it is 'technical'",
        "whyCorrect": "Within 'Plan and manage project compliance,' you must first confirm requirements and analyze the impact of non-compliance before proceeding.",
        "taskCode": "2.1", "mindset": "predictive",
        "keyConcept": "Compliance Planning for New Requirements", "learningObjective": "Apply compliance planning steps for new feature requests",
    },
    # Q15
    {
        "stem": "You are a PM in a product launch project and discover before closing that there are licensing compliance issues. What is the correct action?",
        "optionA": "Deliver the product as-is because the project is almost done",
        "optionB": "Perform a compliance check before project end and document risks with a response plan",
        "optionC": "Ignore because compliance is the legal department's responsibility only",
        "optionD": "Transfer the issue to the operations team after handover",
        "whyCorrect": "PMI emphasizes: check compliance before project end. Risks must be documented with response plans, not transferred or ignored.",
        "taskCode": "2.1", "mindset": "predictive",
        "keyConcept": "Closing Compliance Check", "learningObjective": "Execute compliance verification steps before project closure",
    },
    # Q16
    {
        "stem": "A large company has projects in a highly regulated industry. To ensure ongoing compliance, what is the best structural approach?",
        "optionA": "Rely on the PM's personal judgment",
        "optionB": "Establish a Compliance council including quality/audit + legal/technical specialists",
        "optionC": "Simply increase the budget",
        "optionD": "Reduce stakeholder communication",
        "whyCorrect": "This is directly from the Compliance Five Best Practices — establishing a Compliance Council is a recognized structural control.",
        "taskCode": "2.1", "mindset": "predictive",
        "keyConcept": "Compliance Council", "learningObjective": "Design compliance governance structures for regulated projects",
    },
    # Q17
    {
        "stem": "During planning, the Sponsor asks you to prove the project is compliant with Security and Health & Safety requirements. What is the logical first step?",
        "optionA": "Classify compliance categories",
        "optionB": "Confirm project compliance requirements",
        "optionC": "Analyze consequences of non-compliance",
        "optionD": "Close project",
        "whyCorrect": "The logical order per ECO is: Confirm requirements first (3.1), then classify (3.2), then analyze consequences (3.3).",
        "taskCode": "2.1", "mindset": "predictive",
        "keyConcept": "Compliance Planning Sequence", "learningObjective": "Apply the correct order of compliance planning steps",
    },
    # Q18
    {
        "stem": "You are a PM in an Agile project. The team is complaining that decisions have become unilateral and everyone is working in silos. What is the best integration approach?",
        "optionA": "Impose a detailed Integration plan and prevent any changes",
        "optionB": "Build a Collaborative decision-making environment and involve the team in determining how plans are integrated",
        "optionC": "Let each sub-team decide independently for speed",
        "optionD": "Ask the Sponsor to approve every decision daily",
        "whyCorrect": "In Agile, integration improves through team participation as domain experts. Collaborative decision-making aligns with Agile integration principles.",
        "taskCode": "1.3", "mindset": "agile",
        "keyConcept": "Agile Integration / Collaborative Decision-Making", "learningObjective": "Apply collaborative integration techniques in Agile projects",
    },
    # Q19
    {
        "stem": "The team added a new feature 'to make it better' without a formal request or change order. How do you handle this as a PM?",
        "optionA": "Accept it because it adds value",
        "optionB": "Log it as a Lesson Learned and leave it",
        "optionC": "Treat it as Gold Plating, stop the addition, and handle it through Change Control if the customer wants it",
        "optionD": "Add more features to stay competitive",
        "whyCorrect": "Gold Plating = adding a feature not in the original scope. Even well-intentioned additions must go through Change Control to protect scope.",
        "taskCode": "2.3", "mindset": "predictive",
        "keyConcept": "Gold Plating / Scope Control", "learningObjective": "Identify and address gold plating",
    },
    # Q20
    {
        "stem": "The customer says: 'The product I received does not match the requirements.' The project team says: 'We delivered exactly what the plan said.' Who is correct?",
        "optionA": "Project Management Plan only",
        "optionB": "Product Requirements only",
        "optionC": "Both — Project Scope completeness is measured against the plan; Product Scope completeness is measured against requirements",
        "optionD": "Project Schedule",
        "whyCorrect": "Project Scope is measured against the plan; Product Scope is measured against requirements. Both viewpoints can be simultaneously correct.",
        "taskCode": "2.3", "mindset": "predictive",
        "keyConcept": "Project Scope vs Product Scope", "learningObjective": "Distinguish between project scope and product scope measurement",
    },
    # Q21
    {
        "stem": "In an Agile project, the Sponsor demands you 'fix the scope in full detail from day one.' What is the best response?",
        "optionA": "Agree and write a final, unchangeable detailed scope",
        "optionB": "Explain that Agile reduces early scope definition time, focuses on building the process, and scope evolves through Prototypes/Releases",
        "optionC": "Refuse the project because it is Agile",
        "optionD": "Create only a schedule and ignore scope",
        "whyCorrect": "Agile spends less time upfront defining scope and relies on Prototypes and iterative Releases to evolve scope collaboratively.",
        "taskCode": "2.3", "mindset": "agile",
        "keyConcept": "Agile Scope Management", "learningObjective": "Explain how Agile differs from predictive approaches in scope definition",
    },
    # Q22
    {
        "stem": "You are preparing a Schedule, and stakeholders ask: 'Why do we need it other than tracking dates?' What is the best answer?",
        "optionA": "Schedule is only for time",
        "optionB": "Schedule serves as a communication tool, for managing stakeholder expectations, and as a basis for performance reports",
        "optionC": "Schedule replaces Scope",
        "optionD": "Schedule is used only during Closing",
        "whyCorrect": "Three clear uses were stated: communication tool, stakeholder expectations management, and performance reporting basis.",
        "taskCode": "2.5", "mindset": "predictive",
        "keyConcept": "Schedule Management Purpose", "learningObjective": "Articulate multiple uses of a project schedule",
    },
    # Q23
    {
        "stem": "While building the schedule, you discover your team lacks clear data on dependencies and constraints. What impact does this have?",
        "optionA": "No impact",
        "optionB": "You can accurately develop a schedule because schedule data includes dependencies/constraints/calendars and more",
        "optionC": "Focus on Cost instead of Schedule",
        "optionD": "Cancel the schedule and work Agile only",
        "whyCorrect": "Building a schedule depends on project-specific data including dependencies, constraints, resource calendars, and other inputs.",
        "taskCode": "2.5", "mindset": "predictive",
        "keyConcept": "Schedule Development Inputs", "learningObjective": "Identify key inputs required for schedule development",
    },
    # Q24
    {
        "stem": "The Sponsor wants a 'quick overview' of project status without activity details, focused on key milestones. Which tool is most appropriate?",
        "optionA": "Network Diagram",
        "optionB": "Milestone Chart",
        "optionC": "Detailed Activity List",
        "optionD": "Resource Histogram",
        "whyCorrect": "The Milestone Chart is suitable for management because it focuses on major checkpoints without activity-level detail.",
        "taskCode": "2.5", "mindset": "predictive",
        "keyConcept": "Milestone Chart", "learningObjective": "Select appropriate schedule visualization tools for different audiences",
    },
    # Q25
    {
        "stem": "Your team works Agile and scope changes frequently. What is the best description of scheduling in this context?",
        "optionA": "Detailed schedule for the entire project upfront",
        "optionB": "Iterative scheduling + Pull-based planning",
        "optionC": "Only milestones without iterations",
        "optionD": "No schedule is needed in Agile",
        "whyCorrect": "Agile relies on short iterations, reviewing results, and iterative and pull-based scheduling rather than fixed upfront plans.",
        "taskCode": "2.5", "mindset": "agile",
        "keyConcept": "Agile Scheduling / Pull Planning", "learningObjective": "Compare Agile and predictive scheduling approaches",
    },
    # Q26
    {
        "stem": "Your Agile project scope is still changing heavily. Management requests a detailed cost estimate for the full year. What is the best approach?",
        "optionA": "Create a detailed estimate for the entire year and lock it in",
        "optionB": "Use Lightweight estimation for a high-level forecast and produce Detailed estimates Just-in-time for the near term",
        "optionC": "Refuse to provide any estimate",
        "optionD": "Create a budget and prevent all changes",
        "whyCorrect": "With high uncertainty, a quick high-level forecast plus just-in-time detailed estimates for the near term is the recommended Agile approach.",
        "taskCode": "2.6", "mindset": "agile",
        "keyConcept": "Agile Cost Estimation / Just-in-time planning", "learningObjective": "Apply lightweight estimation techniques in Agile projects",
    },
    # Q27
    {
        "stem": "Who is most likely to measure costs differently from the project manager?",
        "optionA": "Finance department",
        "optionB": "The project team only",
        "optionC": "No one",
        "optionD": "QA only",
        "whyCorrect": "Finance typically focuses on cash flow and accounting methods, while the PM focuses on project-level cost performance and earned value.",
        "taskCode": "2.6", "mindset": "predictive",
        "keyConcept": "Cost Measurement Perspectives", "learningObjective": "Explain how finance and PM perspectives on cost can differ",
    },
    # Q28
    {
        "stem": "During execution, you are trying to prevent defects at the source, improve team processes, and reduce root causes of problems. This is an example of which process?",
        "optionA": "Control Quality",
        "optionB": "Manage Quality",
        "optionC": "Validate Scope",
        "optionD": "Close Project",
        "whyCorrect": "Manage Quality focuses on improving processes and prevention. Control Quality focuses on inspecting deliverables after the fact.",
        "taskCode": "2.7", "mindset": "predictive",
        "keyConcept": "Manage Quality vs Control Quality", "learningObjective": "Distinguish between Manage Quality and Control Quality",
    },
    # Q29
    {
        "stem": "A low-grade product fully meets the customer's requirements with no defects. How is it classified?",
        "optionA": "Low quality, low grade",
        "optionB": "High quality, low grade",
        "optionC": "Low quality, high grade",
        "optionD": "High grade, high quality",
        "whyCorrect": "Grade = category/tier of features; Quality = meeting requirements. A product can be low grade (few features) but high quality (fully meets requirements).",
        "taskCode": "2.7", "mindset": "predictive",
        "keyConcept": "Grade vs Quality", "learningObjective": "Differentiate grade from quality in project management",
    },
    # Q30
    {
        "stem": "Your team suggests increasing inspection at the end of the project instead of improving the process from the beginning. What does this violate?",
        "optionA": "Inspection over Prevention",
        "optionB": "Prevention over Inspection",
        "optionC": "No quality planning needed",
        "optionD": "Increase scope to improve quality",
        "whyCorrect": "Prevention stops errors from entering the process and is more cost-effective than finding and fixing them through inspection after the fact.",
        "taskCode": "2.7", "mindset": "predictive",
        "keyConcept": "Prevention vs Inspection", "learningObjective": "Apply the quality principle: prevention over inspection",
    },
    # Q31
    {
        "stem": "A major defect appeared after delivery, requiring Rework and Warranty repairs, and causing the loss of a customer. This falls under which cost category?",
        "optionA": "Cost of Conformance",
        "optionB": "Cost of Non-Conformance",
        "optionC": "Opportunity cost only",
        "optionD": "Schedule variance",
        "whyCorrect": "Rework, Warranty, and Lost business are direct examples of Cost of Non-Conformance — costs incurred because of failures.",
        "taskCode": "2.7", "mindset": "predictive",
        "keyConcept": "Cost of Quality", "learningObjective": "Classify costs as conformance or non-conformance",
    },
    # Q32
    {
        "stem": "A team member added an extra feature without a formal request, claiming it improves customer satisfaction. This is most likely:",
        "optionA": "Kaizen",
        "optionB": "Gold Plating",
        "optionC": "Control Quality",
        "optionD": "Grade improvement only",
        "whyCorrect": "Gold Plating = adding extras outside what was agreed, even with good intentions. It violates scope integrity and must be handled through Change Control.",
        "taskCode": "2.3", "mindset": "predictive",
        "keyConcept": "Gold Plating", "learningObjective": "Identify gold plating and its impact on scope",
    },
    # Q33
    {
        "stem": "The exam is very sensitive about professional conduct. A team member submitted a report you believe contains false data. What do you do?",
        "optionA": "Ignore it because the goal is to avoid creating problems",
        "optionB": "Confront the person informally only and consider the matter closed",
        "optionC": "Follow the organization's escalation policy and act professionally, because conduct must be ethical",
        "optionD": "Ask the person to change the report without anyone finding out",
        "whyCorrect": "The methodology emphasizes that the team must act professionally and ethically. Informal resolution alone is insufficient when data integrity is compromised.",
        "taskCode": "1.1", "mindset": "predictive",
        "keyConcept": "Professional Ethics / Escalation", "learningObjective": "Apply professional and ethical conduct standards",
    },
    # Q34
    {
        "stem": "You are a PM in a pharmaceutical company and discover during execution that part of the product must comply with a new government regulation. What knowledge area best describes this?",
        "optionA": "Stakeholder Engagement",
        "optionB": "Continuous Improvement",
        "optionC": "Standards & Regulatory Compliance",
        "optionD": "Focus on reducing misunderstandings through written communication",
        "whyCorrect": "The scenario explicitly involves a government regulation — this directly points to Standards & Regulatory Compliance.",
        "taskCode": "2.1", "mindset": "predictive",
        "keyConcept": "Regulatory Compliance", "learningObjective": "Identify regulatory compliance requirements during execution",
    },
    # Q35
    {
        "stem": "Your team is distributed across Cairo, Dubai, and London, and delays are occurring because the same SME is required in multiple locations simultaneously. What is the best solution?",
        "optionA": "Ignore it until it becomes an issue",
        "optionB": "Ask the organization for a resource demand database / visibility",
        "optionC": "Increase team motivation only",
        "optionD": "Remove stakeholders from reviews",
        "whyCorrect": "Having visibility into resource demands across the organization through a database prevents conflicts and enables better resource allocation.",
        "taskCode": "2.8", "mindset": "predictive",
        "keyConcept": "Resource Demand Visibility", "learningObjective": "Identify tools to manage resource conflicts in distributed teams",
    },
    # Q36
    {
        "stem": "In an Agile project with a cross-functional team, the manager noticed productivity increased when the team began exchanging knowledge. What Agile principle does this represent?",
        "optionA": "Risk Avoidance",
        "optionB": "Collaboration to boost productivity and knowledge sharing",
        "optionC": "Regulatory compliance",
        "optionD": "Control Resources only",
        "whyCorrect": "This is directly from Agile Resource Management considerations: Collaboration and knowledge sharing increase team productivity.",
        "taskCode": "2.8", "mindset": "agile",
        "keyConcept": "Agile Team Collaboration", "learningObjective": "Explain how collaboration drives productivity in Agile teams",
    },
    # Q37
    {
        "stem": "You are a PM and stakeholders are complaining that they 'don't know what's new' and there is no clarity in reporting. What is the best first action?",
        "optionA": "Start sending random status emails daily",
        "optionB": "Develop a communication strategy based on stakeholder information needs",
        "optionC": "Stop stakeholder engagement to reduce conflicts",
        "optionD": "Perform quantitative risk analysis",
        "whyCorrect": "Communications Management has two parts; the first is developing a strategy based on stakeholder information needs.",
        "taskCode": "2.9", "mindset": "predictive",
        "keyConcept": "Communications Strategy", "learningObjective": "Develop a communication strategy aligned to stakeholder needs",
    },
    # Q38
    {
        "stem": "You sent a formal email with an important decision, and two days later discovered the execution team misunderstood it. What is the correct conclusion?",
        "optionA": "Written communication eliminates misunderstandings",
        "optionB": "Written communication can reduce misunderstandings but not eliminate them",
        "optionC": "Nonverbal communication is not relevant in projects",
        "optionD": "Only formal communication should be used",
        "whyCorrect": "Written communication reduces misunderstandings but cannot completely eliminate them. Follow-up and confirmation are still necessary.",
        "taskCode": "2.9", "mindset": "predictive",
        "keyConcept": "Written Communication Limitations", "learningObjective": "Explain the limitations of written communication",
    },
    # Q39
    {
        "stem": "You need to send a formal message containing procedures and final deadlines. Which communication method is most appropriate?",
        "optionA": "Informal chat message only",
        "optionB": "Written communication (formal)",
        "optionC": "Nonverbal gestures",
        "optionD": "Avoid communication to reduce conflict",
        "whyCorrect": "Written formal communication is appropriate for decisions, procedures, and deadlines that require a documented record.",
        "taskCode": "2.9", "mindset": "predictive",
        "keyConcept": "Communication Methods Selection", "learningObjective": "Select appropriate communication methods for formal project information",
    },
    # Q40
    {
        "stem": "In a rapidly changing Agile project, the team needs to share more information faster. What is the best communication approach?",
        "optionA": "Reduce communication to avoid confusion",
        "optionB": "Increase transparency of project artifacts and hold regular stakeholder reviews",
        "optionC": "Only use formal written communication",
        "optionD": "Focus only on procurement planning",
        "whyCorrect": "Agile communications focus on transparency and regular stakeholder reviews to maintain alignment in fast-changing environments.",
        "taskCode": "2.9", "mindset": "agile",
        "keyConcept": "Agile Communication Transparency", "learningObjective": "Apply Agile communication principles in a dynamic environment",
    },
    # Q41
    {
        "stem": "A stakeholder says: 'We don't want to waste time on Risk Management — let's just execute.' How do you respond?",
        "optionA": "Agree, because risk management is optional",
        "optionB": "Explain that risk management is essential, especially early when exposure is highest",
        "optionC": "Do quantitative analysis only and skip the rest",
        "optionD": "Focus on quality auditing instead",
        "whyCorrect": "Risk Management is not optional. Early in the project, risk exposure is highest, making early risk identification and planning most valuable.",
        "taskCode": "2.10", "mindset": "predictive",
        "keyConcept": "Risk Management Importance", "learningObjective": "Justify the importance of risk management throughout the project",
    },
    # Q42
    {
        "stem": "During which process group do you define the procurement strategy, Statements of Work (SOW), and procurement approach?",
        "optionA": "During Monitoring & Controlling in Control Procurements",
        "optionB": "During Planning in Plan Procurement Management",
        "optionC": "During Executing in Conduct Procurements",
        "optionD": "During Closing in Close Project",
        "whyCorrect": "Procurement planning (Strategy + SOW + approach) begins during the Planning process group in Plan Procurement Management.",
        "taskCode": "2.11", "mindset": "predictive",
        "keyConcept": "Plan Procurement Management", "learningObjective": "Identify the process group for procurement strategy definition",
    },
    # Q43
    {
        "stem": "After planning and defining the procurement approach, what is the PM's primary role in contract review?",
        "optionA": "The PM must sign contracts personally",
        "optionB": "The PM reviews contract contents and identifies critical clauses for the team",
        "optionC": "The PM prevents any negotiation with vendors",
        "optionD": "The PM ignores legal clauses because they are Legal's responsibility only",
        "whyCorrect": "The PM's role includes reviewing contract contents and clarifying legal and critical clauses for the team — not signing or negotiating alone.",
        "taskCode": "2.11", "mindset": "predictive",
        "keyConcept": "PM Role in Contract Review", "learningObjective": "Describe the PM's responsibilities in contract review",
    },
    # Q44
    {
        "stem": "You are a project manager and the project has just started. You want to quickly identify potential stakeholders without conducting meetings. What is the most efficient technique?",
        "optionA": "Brainstorming",
        "optionB": "Document Analysis",
        "optionC": "Focus Groups",
        "optionD": "Stakeholder Engagement Assessment Matrix",
        "whyCorrect": "Document Analysis — reviewing existing project documents, organizational charts, contracts, and similar records — is the most efficient way to identify stakeholders quickly without meetings.",
        "taskCode": "3.1", "mindset": "predictive",
        "keyConcept": "Stakeholder Identification Techniques", "learningObjective": "Select appropriate techniques for stakeholder identification",
    },
    # Q45
    {
        "stem": "You have many stakeholders and need to classify them to determine who to 'Manage closely' and who to 'Monitor only.' Which tool is most appropriate?",
        "optionA": "Stakeholder Mapping / Representation",
        "optionB": "Lessons Learned Register",
        "optionC": "Kickoff Meeting",
        "optionD": "Cost Baseline",
        "whyCorrect": "Stakeholder Mapping/Representation (e.g., Power/Interest Grid) classifies stakeholders by power, interest, and influence to guide engagement strategies.",
        "taskCode": "3.1", "mindset": "predictive",
        "keyConcept": "Stakeholder Mapping / Power-Interest Grid", "learningObjective": "Apply stakeholder mapping to prioritize engagement",
    },
    # Q46
    {
        "stem": "You completed Identify Stakeholders and started documenting data: name, title, contact info, power, interest, and classification. Which document captures all of this?",
        "optionA": "Stakeholder Register",
        "optionB": "Risk Register",
        "optionC": "Requirements Traceability Matrix",
        "optionD": "Communications Management Plan",
        "whyCorrect": "The Stakeholder Register is the output of Identify Stakeholders and captures identification, assessment, and classification data.",
        "taskCode": "3.1", "mindset": "predictive",
        "keyConcept": "Stakeholder Register", "learningObjective": "Identify the purpose and contents of the stakeholder register",
    },
    # Q47
    {
        "stem": "One of your stakeholders is classified as 'External' and 'Resistant.' What is the first logical PMP-style action?",
        "optionA": "Ignore them because they are resistant",
        "optionB": "Escalate immediately",
        "optionC": "Understand the reason for resistance and build a communication and influence strategy",
        "optionD": "Cancel the project",
        "whyCorrect": "PMP always thinks 'stakeholder management,' not 'ignore them.' Classifying them as resistant triggers a tailored engagement and communication strategy.",
        "taskCode": "3.2", "mindset": "predictive",
        "keyConcept": "Stakeholder Engagement Strategy", "learningObjective": "Develop engagement strategies for resistant stakeholders",
    },
    # Q48
    {
        "stem": "You are early in Planning. Management asked you to document 'how we will define project scope, how we will create the WBS, and how we will validate scope.' Which process produces this?",
        "optionA": "Define Scope",
        "optionB": "Plan Scope Management",
        "optionC": "Validate Scope",
        "optionD": "Control Scope",
        "whyCorrect": "Plan Scope Management produces the Scope Management Plan, which describes how scope will be defined, structured, validated, and controlled.",
        "taskCode": "2.3", "mindset": "predictive",
        "keyConcept": "Plan Scope Management", "learningObjective": "Identify the purpose and output of Plan Scope Management",
    },
    # Q49
    {
        "stem": "You are choosing between two ways to execute part of the project: an external vendor or internal execution. Which tool/technique helps evaluate this decision?",
        "optionA": "Alternatives Analysis",
        "optionB": "Brainstorming",
        "optionC": "Monte Carlo",
        "optionD": "Trend Analysis",
        "whyCorrect": "Alternatives Analysis evaluates and selects among different options for executing project work — in this case, make-or-buy / internal vs. external.",
        "taskCode": "2.11", "mindset": "predictive",
        "keyConcept": "Alternatives Analysis / Make-or-Buy", "learningObjective": "Apply alternatives analysis to procurement decisions",
    },
]

wb = openpyxl.load_workbook('content/starter-drafts-docx2.xlsx')
ws = wb.active
headers = [c.value for c in ws[1]]

col = {h: i+1 for i, h in enumerate(headers)}

for row_idx, t in enumerate(TRANSLATIONS, start=2):
    ws.cell(row=row_idx, column=col['stem']).value          = t['stem']
    ws.cell(row=row_idx, column=col['optionA']).value       = t['optionA']
    ws.cell(row=row_idx, column=col['optionB']).value       = t['optionB']
    ws.cell(row=row_idx, column=col['optionC']).value       = t['optionC']
    ws.cell(row=row_idx, column=col['optionD']).value       = t['optionD']
    ws.cell(row=row_idx, column=col['whyCorrect']).value    = t['whyCorrect']
    ws.cell(row=row_idx, column=col['taskCode']).value      = t.get('taskCode')
    ws.cell(row=row_idx, column=col['mindset']).value       = t.get('mindset')
    ws.cell(row=row_idx, column=col['keyConcept']).value    = t.get('keyConcept')
    ws.cell(row=row_idx, column=col['learningObjective']).value = t.get('learningObjective')

wb.save('content/starter-drafts-docx2.xlsx')
print(f"✅ Filled {len(TRANSLATIONS)} rows with English translations")
