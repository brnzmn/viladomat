/**
 * Hand-written subset of the database types for the tables, views, functions and enums the web
 * app touches. Follows the shape produced by `supabase gen types typescript` so that the
 * supabase-js `Database` generic works unchanged (see README for the regeneration command).
 *
 * Source of truth: supabase/migrations/*.sql. Only the `public` schema is reachable from the browser.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      communities: {
        Row: {
          id: string;
          name: string;
          nif: string | null;
          address: string | null;
          catastro_rc: string | null;
          fy_start_month: number;
          ordinary_budget_default: number | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          nif?: string | null;
          address?: string | null;
          catastro_rc?: string | null;
          fy_start_month?: number;
          ordinary_budget_default?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          nif?: string | null;
          address?: string | null;
          catastro_rc?: string | null;
          fy_start_month?: number;
          ordinary_budget_default?: number | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      community_members: {
        Row: {
          user_id: string;
          community_id: string;
          role: Database['public']['Enums']['member_role'];
          valid_until: string | null;
          created_at: string;
        };
        Insert: {
          user_id: string;
          community_id: string;
          role?: Database['public']['Enums']['member_role'];
          valid_until?: string | null;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          community_id?: string;
          role?: Database['public']['Enums']['member_role'];
          valid_until?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      units: {
        Row: {
          id: string;
          community_id: string;
          label: string;
          floor: string | null;
          door: string | null;
          use: string | null;
          quota_pct: number | null;
          catastro_rc20: string | null;
          surface_m2: number | null;
          holder_role: Database['public']['Enums']['holder_role'];
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          label: string;
          floor?: string | null;
          door?: string | null;
          use?: string | null;
          quota_pct?: number | null;
          catastro_rc20?: string | null;
          surface_m2?: number | null;
          holder_role?: Database['public']['Enums']['holder_role'];
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          label?: string;
          floor?: string | null;
          door?: string | null;
          use?: string | null;
          quota_pct?: number | null;
          catastro_rc20?: string | null;
          surface_m2?: number | null;
          holder_role?: Database['public']['Enums']['holder_role'];
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      community_rules: {
        Row: {
          id: string;
          community_id: string;
          topic: Database['public']['Enums']['rule_topic'];
          text_literal: string;
          source_document_id: string | null;
          page_no: number | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          topic: Database['public']['Enums']['rule_topic'];
          text_literal: string;
          source_document_id?: string | null;
          page_no?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          topic?: Database['public']['Enums']['rule_topic'];
          text_literal?: string;
          source_document_id?: string | null;
          page_no?: number | null;
          created_at?: string;
        };
        Relationships: [];
      };
      parameters: {
        Row: {
          id: string;
          community_id: string;
          key: string;
          value_num: number | null;
          value_text: string | null;
          unit: string | null;
          basis_text: string | null;
          version: number;
          valid_from: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          key: string;
          value_num?: number | null;
          value_text?: string | null;
          unit?: string | null;
          basis_text?: string | null;
          version?: number;
          valid_from?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          key?: string;
          value_num?: number | null;
          value_text?: string | null;
          unit?: string | null;
          basis_text?: string | null;
          version?: number;
          valid_from?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      files: {
        Row: {
          id: string;
          community_id: string;
          sha256: string;
          client_sha256: string | null;
          server_sha256: string | null;
          hash_verified: boolean | null;
          storage_path: string;
          original_name: string;
          mime: string | null;
          bytes: number | null;
          source: Database['public']['Enums']['file_source'];
          supplied_by_role: string | null;
          supplied_on: string | null;
          batch_label: string | null;
          transport_note: string | null;
          exif: Json | null;
          pdf_meta: Json | null;
          email_auth: Json | null;
          capture_time: string | null;
          page_count: number | null;
          parent_file_id: string | null;
          status: Database['public']['Enums']['file_status'];
          uploaded_by: string | null;
          uploaded_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          sha256: string;
          client_sha256?: string | null;
          server_sha256?: string | null;
          hash_verified?: boolean | null;
          storage_path: string;
          original_name: string;
          mime?: string | null;
          bytes?: number | null;
          source: Database['public']['Enums']['file_source'];
          supplied_by_role?: string | null;
          supplied_on?: string | null;
          batch_label?: string | null;
          transport_note?: string | null;
          exif?: Json | null;
          pdf_meta?: Json | null;
          email_auth?: Json | null;
          capture_time?: string | null;
          page_count?: number | null;
          parent_file_id?: string | null;
          status?: Database['public']['Enums']['file_status'];
          uploaded_by?: string | null;
          uploaded_at?: string;
        };
        Update: {
          server_sha256?: string | null;
          hash_verified?: boolean | null;
          status?: Database['public']['Enums']['file_status'];
          page_count?: number | null;
        };
        Relationships: [];
      };
      jobs: {
        Row: {
          id: string;
          community_id: string;
          idempotency_key: string;
          step: string;
          status: Database['public']['Enums']['job_status'];
          priority: number;
          attempts: number;
          max_attempts: number;
          run_after: string;
          locked_by: string | null;
          locked_at: string | null;
          last_error: string | null;
          payload: Json | null;
          result: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          idempotency_key: string;
          step: string;
          status?: Database['public']['Enums']['job_status'];
          priority?: number;
          attempts?: number;
          max_attempts?: number;
          run_after?: string;
          locked_by?: string | null;
          locked_at?: string | null;
          last_error?: string | null;
          payload?: Json | null;
          result?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          idempotency_key?: string;
          step?: string;
          status?: Database['public']['Enums']['job_status'];
          priority?: number;
          attempts?: number;
          max_attempts?: number;
          run_after?: string;
          locked_by?: string | null;
          locked_at?: string | null;
          last_error?: string | null;
          payload?: Json | null;
          result?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      works_packages: {
        Row: {
          id: string;
          community_id: string;
          code: Database['public']['Enums']['works_code'];
          label: string | null;
          status: Database['public']['Enums']['works_status'];
          architect_pem: number | null;
          permit_pem: number | null;
          subsidy_protegible: number | null;
          contract_price: number | null;
          suspension_date: string | null;
          suspension_reason: Database['public']['Enums']['suspension_reason'] | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          code: Database['public']['Enums']['works_code'];
          label?: string | null;
          status?: Database['public']['Enums']['works_status'];
          architect_pem?: number | null;
          permit_pem?: number | null;
          subsidy_protegible?: number | null;
          contract_price?: number | null;
          suspension_date?: string | null;
          suspension_reason?: Database['public']['Enums']['suspension_reason'] | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          code?: Database['public']['Enums']['works_code'];
          label?: string | null;
          status?: Database['public']['Enums']['works_status'];
          architect_pem?: number | null;
          permit_pem?: number | null;
          subsidy_protegible?: number | null;
          contract_price?: number | null;
          suspension_date?: string | null;
          suspension_reason?: Database['public']['Enums']['suspension_reason'] | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      documents: {
        Row: {
          id: string;
          community_id: string;
          doc_type: string;
          status: Database['public']['Enums']['doc_status'];
          doc_date: string | null;
          fiscal_year: number | null;
          issuer_party_id: string | null;
          recipient_party_id: string | null;
          language: string | null;
          issuer_class: Database['public']['Enums']['issuer_class'];
          provenance_chain: string[];
          obtained_directly: boolean;
          grouping_confidence: number | null;
          grouping_reason: string | null;
          grouped_by: Database['public']['Enums']['grouped_by'];
          current_run_id: string | null;
          works_package_id: string | null;
          duplicate_of_document_id: string | null;
          dedupe_key: string | null;
          title: string | null;
          summary: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          doc_type: string;
          status?: Database['public']['Enums']['doc_status'];
          doc_date?: string | null;
          fiscal_year?: number | null;
          issuer_party_id?: string | null;
          recipient_party_id?: string | null;
          language?: string | null;
          issuer_class?: Database['public']['Enums']['issuer_class'];
          provenance_chain?: string[];
          obtained_directly?: boolean;
          grouping_confidence?: number | null;
          grouping_reason?: string | null;
          grouped_by?: Database['public']['Enums']['grouped_by'];
          current_run_id?: string | null;
          works_package_id?: string | null;
          duplicate_of_document_id?: string | null;
          dedupe_key?: string | null;
          title?: string | null;
          summary?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          doc_type?: string;
          status?: Database['public']['Enums']['doc_status'];
          doc_date?: string | null;
          fiscal_year?: number | null;
          issuer_party_id?: string | null;
          recipient_party_id?: string | null;
          language?: string | null;
          issuer_class?: Database['public']['Enums']['issuer_class'];
          provenance_chain?: string[];
          obtained_directly?: boolean;
          grouping_confidence?: number | null;
          grouping_reason?: string | null;
          grouped_by?: Database['public']['Enums']['grouped_by'];
          current_run_id?: string | null;
          works_package_id?: string | null;
          duplicate_of_document_id?: string | null;
          dedupe_key?: string | null;
          title?: string | null;
          summary?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      bank_accounts: {
        Row: {
          id: string;
          community_id: string;
          label: string;
          iban_hmac: string | null;
          iban_last4: string | null;
          iban_enc: string | null;
          enc_key_version: number | null;
          bank_code: string | null;
          bank_name: string | null;
          holder_as_shown: string | null;
          holder_kind: Database['public']['Enums']['holder_kind'];
          purpose: Database['public']['Enums']['account_purpose'];
          titled_to_community: boolean | null;
          signatory_roles: string[] | null;
          holder_certificate_document_id: string | null;
          opened_on: string | null;
          closed_on: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          label: string;
          iban_hmac?: string | null;
          iban_last4?: string | null;
          iban_enc?: string | null;
          enc_key_version?: number | null;
          bank_code?: string | null;
          bank_name?: string | null;
          holder_as_shown?: string | null;
          holder_kind?: Database['public']['Enums']['holder_kind'];
          purpose?: Database['public']['Enums']['account_purpose'];
          titled_to_community?: boolean | null;
          signatory_roles?: string[] | null;
          holder_certificate_document_id?: string | null;
          opened_on?: string | null;
          closed_on?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          label?: string;
          iban_hmac?: string | null;
          iban_last4?: string | null;
          iban_enc?: string | null;
          enc_key_version?: number | null;
          bank_code?: string | null;
          bank_name?: string | null;
          holder_as_shown?: string | null;
          holder_kind?: Database['public']['Enums']['holder_kind'];
          purpose?: Database['public']['Enums']['account_purpose'];
          titled_to_community?: boolean | null;
          signatory_roles?: string[] | null;
          holder_certificate_document_id?: string | null;
          opened_on?: string | null;
          closed_on?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      meetings: {
        Row: {
          id: string;
          community_id: string;
          document_id: string | null;
          tipo: Database['public']['Enums']['meeting_kind'];
          fecha: string;
          convocatoria_fecha: string | null;
          convened_by_role: string | null;
          lugar: string | null;
          quorum_pct: number | null;
          attendees: Json | null;
          cuentas_aprobadas: boolean | null;
          presupuesto_aprobado: number | null;
          firma_presidente: boolean | null;
          firma_secretario: boolean | null;
          fecha_firma: string | null;
          fecha_notificacion: string | null;
          notice_days: number | null;
          signed_within_5d: boolean | null;
          sent_within_10d: boolean | null;
          entry_source: Database['public']['Enums']['entry_source'];
          seed_verified_by: string | null;
          seed_verified_at: string | null;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          document_id?: string | null;
          tipo: Database['public']['Enums']['meeting_kind'];
          fecha: string;
          convocatoria_fecha?: string | null;
          convened_by_role?: string | null;
          lugar?: string | null;
          quorum_pct?: number | null;
          attendees?: Json | null;
          cuentas_aprobadas?: boolean | null;
          presupuesto_aprobado?: number | null;
          firma_presidente?: boolean | null;
          firma_secretario?: boolean | null;
          fecha_firma?: string | null;
          fecha_notificacion?: string | null;
          entry_source?: Database['public']['Enums']['entry_source'];
          seed_verified_by?: string | null;
          seed_verified_at?: string | null;
          notes?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          document_id?: string | null;
          tipo?: Database['public']['Enums']['meeting_kind'];
          fecha?: string;
          convocatoria_fecha?: string | null;
          convened_by_role?: string | null;
          lugar?: string | null;
          quorum_pct?: number | null;
          attendees?: Json | null;
          cuentas_aprobadas?: boolean | null;
          presupuesto_aprobado?: number | null;
          firma_presidente?: boolean | null;
          firma_secretario?: boolean | null;
          fecha_firma?: string | null;
          fecha_notificacion?: string | null;
          entry_source?: Database['public']['Enums']['entry_source'];
          seed_verified_by?: string | null;
          seed_verified_at?: string | null;
          notes?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      resolutions: {
        Row: {
          id: string;
          community_id: string;
          meeting_id: string;
          punto: string | null;
          texto_literal: string;
          kind: Database['public']['Enums']['resolution_kind'];
          resultado: Database['public']['Enums']['resolution_result'];
          votos: Json | null;
          quotas_favor_pct: number | null;
          voters_favor: number | null;
          voters_total: number | null;
          importe_aprobado: number | null;
          tolerance_pct: number | null;
          vendor_party_id: string | null;
          works_package_id: string | null;
          delegation_to_role: string | null;
          delegation_scope: string | null;
          delegation_cap: number | null;
          cap_explicit: boolean | null;
          challenge_3m_until: string | null;
          challenge_12m_until: string | null;
          page_id: string | null;
          page_no: number | null;
          entry_source: Database['public']['Enums']['entry_source'];
          created_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          meeting_id: string;
          punto?: string | null;
          texto_literal: string;
          kind?: Database['public']['Enums']['resolution_kind'];
          resultado?: Database['public']['Enums']['resolution_result'];
          votos?: Json | null;
          quotas_favor_pct?: number | null;
          voters_favor?: number | null;
          voters_total?: number | null;
          importe_aprobado?: number | null;
          tolerance_pct?: number | null;
          vendor_party_id?: string | null;
          works_package_id?: string | null;
          delegation_to_role?: string | null;
          delegation_scope?: string | null;
          delegation_cap?: number | null;
          cap_explicit?: boolean | null;
          page_id?: string | null;
          page_no?: number | null;
          entry_source?: Database['public']['Enums']['entry_source'];
          created_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          meeting_id?: string;
          punto?: string | null;
          texto_literal?: string;
          kind?: Database['public']['Enums']['resolution_kind'];
          resultado?: Database['public']['Enums']['resolution_result'];
          votos?: Json | null;
          quotas_favor_pct?: number | null;
          voters_favor?: number | null;
          voters_total?: number | null;
          importe_aprobado?: number | null;
          tolerance_pct?: number | null;
          vendor_party_id?: string | null;
          works_package_id?: string | null;
          delegation_to_role?: string | null;
          delegation_scope?: string | null;
          delegation_cap?: number | null;
          cap_explicit?: boolean | null;
          page_id?: string | null;
          page_no?: number | null;
          entry_source?: Database['public']['Enums']['entry_source'];
          created_at?: string;
        };
        Relationships: [];
      };
      derramas: {
        Row: {
          id: string;
          community_id: string;
          resolution_id: string | null;
          objeto: string;
          works_package_id: string | null;
          importe_total: number | null;
          criterio: Database['public']['Enums']['derrama_criterio'];
          per_unit_amount: number | null;
          starts_on: string | null;
          ends_on: string | null;
          months: number | null;
          target_account_id: string | null;
          entry_source: Database['public']['Enums']['entry_source'];
          created_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          resolution_id?: string | null;
          objeto: string;
          works_package_id?: string | null;
          importe_total?: number | null;
          criterio?: Database['public']['Enums']['derrama_criterio'];
          per_unit_amount?: number | null;
          starts_on?: string | null;
          ends_on?: string | null;
          months?: number | null;
          target_account_id?: string | null;
          entry_source?: Database['public']['Enums']['entry_source'];
          created_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          resolution_id?: string | null;
          objeto?: string;
          works_package_id?: string | null;
          importe_total?: number | null;
          criterio?: Database['public']['Enums']['derrama_criterio'];
          per_unit_amount?: number | null;
          starts_on?: string | null;
          ends_on?: string | null;
          months?: number | null;
          target_account_id?: string | null;
          entry_source?: Database['public']['Enums']['entry_source'];
          created_at?: string;
        };
        Relationships: [];
      };
      request_clock: {
        Row: {
          id: string;
          community_id: string;
          request_date: string | null;
          request_evidence_document_id: string | null;
          quotas_pct_requesting: number | null;
          units_requesting: number | null;
          convocation_date: string | null;
          junta_date: string | null;
          notice_days: number | null;
          docs_available_from: string | null;
          status: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          request_date?: string | null;
          request_evidence_document_id?: string | null;
          quotas_pct_requesting?: number | null;
          units_requesting?: number | null;
          convocation_date?: string | null;
          junta_date?: string | null;
          docs_available_from?: string | null;
          status?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          request_date?: string | null;
          request_evidence_document_id?: string | null;
          quotas_pct_requesting?: number | null;
          units_requesting?: number | null;
          convocation_date?: string | null;
          junta_date?: string | null;
          docs_available_from?: string | null;
          status?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      findings: {
        Row: {
          id: string;
          community_id: string;
          rule_code: string;
          rule_version: number;
          fingerprint: string;
          event_key: string | null;
          severity: number;
          extraction_quality: number | null;
          specificity: number | null;
          independence: number | null;
          confidence: number | null;
          hit_score: number | null;
          entity_type: string | null;
          entity_id: string | null;
          works_package_id: string | null;
          fiscal_year: number | null;
          amount_at_stake: number | null;
          act_date_first: string | null;
          act_date_last: string | null;
          computed: Json | null;
          summary_es: string | null;
          summary_en: string | null;
          innocent_explanations: Json | null;
          next_check: string | null;
          resolving_document: string | null;
          tier: Database['public']['Enums']['finding_tier'] | null;
          status: Database['public']['Enums']['finding_status'];
          explanation_requested_on: string | null;
          explanation_letter_file_id: string | null;
          explanation_received_on: string | null;
          four_eyes_ok: boolean;
          first_seen_run_id: string | null;
          last_seen_run_id: string | null;
          superseded_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          community_id: string;
          rule_code: string;
          rule_version: number;
          fingerprint: string;
          event_key?: string | null;
          severity: number;
          extraction_quality?: number | null;
          specificity?: number | null;
          independence?: number | null;
          confidence?: number | null;
          hit_score?: number | null;
          entity_type?: string | null;
          entity_id?: string | null;
          works_package_id?: string | null;
          fiscal_year?: number | null;
          amount_at_stake?: number | null;
          act_date_first?: string | null;
          act_date_last?: string | null;
          computed?: Json | null;
          summary_es?: string | null;
          summary_en?: string | null;
          innocent_explanations?: Json | null;
          next_check?: string | null;
          resolving_document?: string | null;
          tier?: Database['public']['Enums']['finding_tier'] | null;
          status?: Database['public']['Enums']['finding_status'];
          explanation_requested_on?: string | null;
          explanation_letter_file_id?: string | null;
          explanation_received_on?: string | null;
          four_eyes_ok?: boolean;
          first_seen_run_id?: string | null;
          last_seen_run_id?: string | null;
          superseded_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          community_id?: string;
          rule_code?: string;
          rule_version?: number;
          fingerprint?: string;
          event_key?: string | null;
          severity?: number;
          extraction_quality?: number | null;
          specificity?: number | null;
          independence?: number | null;
          confidence?: number | null;
          hit_score?: number | null;
          entity_type?: string | null;
          entity_id?: string | null;
          works_package_id?: string | null;
          fiscal_year?: number | null;
          amount_at_stake?: number | null;
          act_date_first?: string | null;
          act_date_last?: string | null;
          computed?: Json | null;
          summary_es?: string | null;
          summary_en?: string | null;
          innocent_explanations?: Json | null;
          next_check?: string | null;
          resolving_document?: string | null;
          tier?: Database['public']['Enums']['finding_tier'] | null;
          status?: Database['public']['Enums']['finding_status'];
          explanation_requested_on?: string | null;
          explanation_letter_file_id?: string | null;
          explanation_received_on?: string | null;
          four_eyes_ok?: boolean;
          first_seen_run_id?: string | null;
          last_seen_run_id?: string | null;
          superseded_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      rules: {
        Row: {
          code: string;
          family: string;
          version: number;
          name_es: string;
          name_ca: string | null;
          name_en: string;
          description: string | null;
          severity_default: number;
          specificity_prior: number;
          legal_basis_kind: Database['public']['Enums']['legal_basis_kind'];
          attribution: Database['public']['Enums']['rule_attribution'];
          article_refs: string[];
          legal_source_ids: string[];
          enabled_in_v1: boolean;
          worklist_eligible: boolean;
          never_t1t2: boolean;
          milestone: string | null;
          fp_notes: string | null;
          changelog: string | null;
          updated_at: string;
        };
        Insert: {
          code: string;
          family: string;
          version?: number;
          name_es: string;
          name_ca?: string | null;
          name_en: string;
          description?: string | null;
          severity_default: number;
          specificity_prior?: number;
          legal_basis_kind?: Database['public']['Enums']['legal_basis_kind'];
          attribution?: Database['public']['Enums']['rule_attribution'];
          article_refs?: string[];
          legal_source_ids?: string[];
          enabled_in_v1?: boolean;
          worklist_eligible?: boolean;
          never_t1t2?: boolean;
          milestone?: string | null;
          fp_notes?: string | null;
          changelog?: string | null;
          updated_at?: string;
        };
        Update: {
          code?: string;
          family?: string;
          version?: number;
          name_es?: string;
          name_ca?: string | null;
          name_en?: string;
          description?: string | null;
          severity_default?: number;
          specificity_prior?: number;
          legal_basis_kind?: Database['public']['Enums']['legal_basis_kind'];
          attribution?: Database['public']['Enums']['rule_attribution'];
          article_refs?: string[];
          legal_source_ids?: string[];
          enabled_in_v1?: boolean;
          worklist_eligible?: boolean;
          never_t1t2?: boolean;
          milestone?: string | null;
          fp_notes?: string | null;
          changelog?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      v_works_funding: {
        Row: {
          community_id: string | null;
          works_package_id: string | null;
          code: Database['public']['Enums']['works_code'] | null;
          label: string | null;
          status: Database['public']['Enums']['works_status'] | null;
          architect_pem: number | null;
          permit_pem: number | null;
          subsidy_protegible: number | null;
          contract_price: number | null;
          certified_total: number | null;
          invoiced_total: number | null;
          extras_total: number | null;
          paid_total: number | null;
          derrama_expected: number | null;
          derrama_collected: number | null;
          subsidy_received: number | null;
          loan_received: number | null;
          committed: number | null;
          available: number | null;
          funding_gap: number | null;
          suspension_date: string | null;
          suspension_reason: Database['public']['Enums']['suspension_reason'] | null;
        };
        Relationships: [];
      };
      v_document_matrix: {
        Row: {
          community_id: string | null;
          class: Database['public']['Enums']['request_class'] | null;
          fiscal_year: number | null;
          status: Database['public']['Enums']['request_status'] | null;
          requested_on: string | null;
          received_on: string | null;
          files_received: number | null;
          request_evidenced: boolean | null;
        };
        Relationships: [];
      };
      v_r7_statement_months_missing: {
        Row: {
          community_id: string | null;
          bank_account_id: string | null;
          month_start: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      log_access: {
        Args: {
          cid: string;
          act: Database['public']['Enums']['audit_action'];
          etype?: string | null;
          eid?: string | null;
          before_j?: Json | null;
          after_j?: Json | null;
          why?: string | null;
        };
        Returns: number;
      };
      param: {
        Args: { cid: string; k: string; on_date?: string };
        Returns: number | null;
      };
    };
    Enums: {
      member_role: 'owner_reviewer' | 'second_reviewer' | 'viewer' | 'auditor_readonly';
      holder_role: 'president' | 'requesting_owner' | 'other_owner' | 'unknown';
      rule_topic:
        | 'quota_criterion'
        | 'works_threshold'
        | 'delegation_limit'
        | 'reserve_fund'
        | 'meeting'
        | 'other';
      issuer_class:
        | 'bank'
        | 'public_registry'
        | 'vendor_direct'
        | 'administrator'
        | 'president'
        | 'requesting_owner'
        | 'unknown';
      file_source:
        | 'web_upload'
        | 'local'
        | 'drive'
        | 'gmail'
        | 'admin_delivery'
        | 'bank_export'
        | 'phone_transfer'
        | 'onsite';
      file_status: 'stored' | 'quarantined' | 'duplicate';
      doc_status: 'grouped' | 'classified' | 'extracted' | 'verified' | 'reviewed' | 'rejected';
      grouped_by: 'auto' | 'human' | 'seed';
      job_status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
      holder_kind: 'community' | 'administrator_pooled' | 'other' | 'unknown';
      account_purpose: 'ordinary' | 'reserve' | 'works' | 'unknown';
      meeting_kind: 'ordinaria' | 'extraordinaria';
      entry_source: 'seed' | 'extraction';
      resolution_kind:
        | 'works_approval'
        | 'contractor_choice'
        | 'budget'
        | 'accounts'
        | 'derrama'
        | 'delegation'
        | 'election'
        | 'loan'
        | 'subsidy'
        | 'audit'
        | 'info'
        | 'other';
      resolution_result: 'aprobado' | 'rechazado' | 'informado' | 'pendiente';
      derrama_criterio: 'coeficiente' | 'partes_iguales' | 'otro';
      works_code:
        | 'ELEVATOR'
        | 'STAIRCASE'
        | 'ENTRANCE_DOOR'
        | 'INTERCOM'
        | 'WINDOWS'
        | 'PAINT_INT'
        | 'REAR_FACADE'
        | 'SEWER'
        | 'DRAIN'
        | 'OTHER';
      works_status:
        | 'planned'
        | 'approved'
        | 'contracted'
        | 'in_progress'
        | 'suspended'
        | 'completed'
        | 'unknown';
      suspension_reason: 'seasonal' | 'contractual' | 'dispute' | 'permit' | 'unknown';
      request_class:
        | 'accounts'
        | 'budget'
        | 'derrama_statement'
        | 'invoices'
        | 'bank_statements'
        | 'bank_statements_norma43'
        | 'bank_holder_certificate'
        | 'contracts'
        | 'elevator_contract'
        | 'certifications'
        | 'permit'
        | 'subsidy'
        | 'modelo_347'
        | 'insurance_policy'
        | 'related_party_declaration'
        | 'statutes'
        | 'other';
      request_status: 'planned' | 'requested' | 'partial' | 'received' | 'inspected_only' | 'refused';
      legal_basis_kind: 'statutory' | 'subsidy_bases' | 'professional_standard' | 'internal_control';
      rule_attribution: 'vendor_compliance' | 'administrator_process' | 'governance' | 'funds';
      finding_status:
        | 'new'
        | 'in_review'
        | 'sent_for_explanation'
        | 'explained'
        | 'confirmed_discrepancy'
        | 'needs_document'
        | 'dismissed_fp';
      finding_tier: 'T1' | 'T2' | 'T3';
      audit_action:
        | 'view'
        | 'download'
        | 'edit'
        | 'status_change'
        | 'export'
        | 'login'
        | 'rule_run'
        | 'external_check'
        | 'seed'
        | 'ingest';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
export type Views<T extends keyof Database['public']['Views']> =
  Database['public']['Views'][T]['Row'];
export type Enums<T extends keyof Database['public']['Enums']> = Database['public']['Enums'][T];
