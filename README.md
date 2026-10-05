# Bank-Management-System
Software Engineering project – Bank Management System
# 🏦 Bank Management System

A Software Engineering project that implements a **Bank Management System (BMS)** for managing customers, bank accounts, transactions, fund transfers, loans, notifications, reports, and administrative operations.

---

## 📌 Project Overview

The **Bank Management System** is designed to provide a secure and organized platform for performing common banking operations.

The system supports different users such as **Customers, Bank Staff, Administrators, and Auditors**, with access controlled according to their roles.

The project focuses on:

- Secure authentication and authorization
- Customer and account management
- Banking transactions
- Fund transfers
- Loan management
- Notifications
- Reports and statements
- Audit logging
- Security and role-based access control

---

## 👥 Team Members

| Name | SRN | Role |
|---|---|---|
| **SRIKANTH V REDDY** | PES2UG24CS519 | QA Lead |
| **T. MAHALAKSHMI** | PES2UG24CS558 | Test Engineer |
| **SUDHANWA** | PES2UG24CS531 | Developer |
| **SRUJAN** | PES2UG24CS526 | Product Owner / Bank Representative |

---

## ✨ Features

### 🔐 Authentication & User Management
- Secure customer and staff login
- OTP-based verification
- Customer profile management
- KYC information management
- Account creation and management
- Role-based access control

### 💰 Banking Transactions
- Balance inquiry
- Cash deposits
- Cash withdrawals
- Fund transfers
- Beneficiary management
- Transaction history
- Account statements

### 🏦 Loan Management
- Loan application
- Loan approval/rejection
- Loan repayment schedule
- Loan repayment tracking
- Loan status management

### 🔔 Notifications
Notifications can be generated for events such as:

- Successful fund transfers
- Withdrawals
- Password changes
- Loan status changes

### 👨‍💼 Administration
- User management
- Role management
- Account management
- Operational reports
- Audit logs
- System monitoring

---

## 🏗️ System Architecture

The system follows a **layered service-oriented architecture**.

Major components include:

```text
                 ┌──────────────────────┐
                 │   Customer / Staff   │
                 │         UI           │
                 └──────────┬───────────┘
                            │
                            ▼
                 ┌──────────────────────┐
                 │     API Gateway      │
                 └──────────┬───────────┘
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
   Authentication      Account Service   Transaction Service
      Service
          │                 │                 │
          │                 └────────┬────────┘
          │                          │
          ▼                          ▼
   Notification                  Database
     Service
          │
          ▼
    Loan Service
          │
          ▼
   Reporting & Audit
